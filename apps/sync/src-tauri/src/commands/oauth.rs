// oauth.rs — OAuth loopback listener + PKCE login flow for HQ Sync menubar.
//
// Starts a one-shot HTTP server on 127.0.0.1:53682 and advertises the
// callback as http://localhost:53682/callback, which matches the
// `http://localhost:*/callback` wildcard registered on Cognito app client
// 7acei2c8v870enheptb1j5foln (hq-prod stack, canonical post-2026-04-25 cutover).
// Binding the loopback addresses 127.0.0.1 and ::1 (never 0.0.0.0/::) keeps the
// listener off the LAN. `localhost` in the redirect URI is required because
// Cognito matches the host segment literally — `127.0.0.1` fails — and because
// macOS commonly resolves `localhost` to ::1 first, we bind both families so
// the callback lands no matter which one the browser picks.
// and waits for the browser to redirect back to /callback?code=...&state=...
// with the authorization code. Responds with a friendly HTML page that tells
// the user to return to HQ Sync, then shuts the listener down.
//
// Login flow (Svelte frontend):
//   1. Call `start_oauth_login` — binds the loopback listener *and* returns
//      authorize URL + state. Binding here (not in step 3) closes the race
//      where a very fast provider redirect could hit the callback port
//      before anything was listening on it.
//   2. Call `tauri_plugin_shell::open(authorize_url)` to open the browser.
//   3. Call `oauth_listen_for_code(state)` to block on the listener bound
//      in step 1 until the callback arrives.
//   4. Call `oauth_exchange_code(code)` to exchange the code for tokens.
//
// Security notes:
//   - Binds loopback only (127.0.0.1 and ::1) — never 0.0.0.0/::.
//   - Enforces `state` match between what the listener was started with and
//     what comes back on the callback, defending against CSRF/code injection.
//   - Single-use: accepts at most one request, closes listener afterwards.
//   - 5-minute timeout so a stalled/abandoned flow doesn't leak a socket.
//   - PKCE (S256) prevents authorization code interception.
//
// Error contract with the frontend (see `onboarding-signin.ts::mapSignInError`):
//   Errors that the UI should show a friendly, specific message for are
//   returned as a JSON string `{"code": "...", "message": "..."}` rather than
//   a plain string, so the frontend can pattern-match on `code` instead of
//   sniffing English text. Currently: `OAUTH_PORT_IN_USE`, `OAUTH_PROVIDER_ERROR`.

use super::cognito::{self, AuthState, CognitoTokens};
use hq_desktop_core::oauth::{
    build_authorize_url, cognito_identity_provider, cognito_token_url, compute_code_challenge,
    generate_code_verifier, parse_callback, COGNITO_CLIENT_ID, REDIRECT_URI,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

const LOOPBACK_PORT: u16 = 53682;
const LOOPBACK_HOST: &str = "127.0.0.1";
const IPV6_LOOPBACK_HOST: &str = "::1";
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

// ── PKCE verifier storage ──────────────────────────────────────────────

static PKCE_VERIFIER: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn pkce_store() -> &'static Mutex<Option<String>> {
    PKCE_VERIFIER.get_or_init(|| Mutex::new(None))
}

// ── Pre-bound loopback listener storage ─────────────────────────────────
//
// Bound eagerly in `start_oauth_login` (before the browser opens) rather
// than lazily in `oauth_listen_for_code`, so the socket is guaranteed ready
// before the user could possibly complete the provider redirect.
//
// We keep a *set* of listeners — one on 127.0.0.1 and one on `::1` — because
// the redirect URI uses `localhost`, and macOS commonly resolves `localhost`
// to IPv6 (`::1`) first. Binding IPv4 only would let the browser's callback
// hit `[::1]:53682` with nothing listening, hanging sign-in until the timeout.

struct PendingListener {
    state: String,
    cancelled: Arc<AtomicBool>,
    result: Option<mpsc::Receiver<Result<OAuthResult, String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

static PENDING_LISTENER: OnceLock<Mutex<Option<PendingListener>>> = OnceLock::new();

fn listener_store() -> &'static Mutex<Option<PendingListener>> {
    PENDING_LISTENER.get_or_init(|| Mutex::new(None))
}

/// Bind loopback listeners for the callback on both IPv4 (`127.0.0.1`) and,
/// when available, IPv6 (`::1`) on the *same* port. Returns whatever bound;
/// only errors if neither family could bind (e.g. the port is truly in use).
/// Never binds `0.0.0.0`/`::` — the listener stays off the LAN.
fn bind_loopback_listeners(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let mut listeners = Vec::with_capacity(2);
    let mut first_error = None;
    let mut bind_port = port;

    match TcpListener::bind((LOOPBACK_HOST, port)) {
        Ok(listener) => {
            if port == 0 {
                bind_port = listener.local_addr()?.port();
            }
            listeners.push(listener);
        }
        Err(e) => first_error = Some(e),
    }

    match TcpListener::bind((IPV6_LOOPBACK_HOST, bind_port)) {
        Ok(listener) => listeners.push(listener),
        Err(e) => {
            if first_error.is_none() {
                first_error = Some(e);
            }
        }
    }

    if listeners.is_empty() {
        Err(first_error.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "no loopback listeners bound",
            )
        }))
    } else {
        Ok(listeners)
    }
}

/// Read the first HTTP request chunk without blocking cancellation. Browsers
/// send loopback redirects in a single small request; a peer that connects but
/// sends no request is discarded after `READ_TIMEOUT` instead of pinning the
/// listener thread and preventing Retry from releasing the callback port.
fn read_request_line(
    stream: &mut TcpStream,
    cancelled: &AtomicBool,
) -> std::io::Result<String> {
    stream.set_nonblocking(true)?;
    let deadline = std::time::Instant::now() + READ_TIMEOUT;
    let mut buf = [0u8; 4096];

    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "OAuth listener cancelled",
            ));
        }

        match stream.read(&mut buf) {
            Ok(n) => return Ok(String::from_utf8_lossy(&buf[..n]).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "Timed out waiting for OAuth callback request",
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

fn receive_loopback_callback(
    listeners: Vec<TcpListener>,
    expected_state: String,
    cancelled: Arc<AtomicBool>,
) -> Result<OAuthResult, String> {
    // Non-blocking accept on every bound listener (IPv4 + IPv6) so the
    // deadline check below actually runs. A blocking accept() on a single
    // socket would sit forever ignoring the 5-minute timeout — and on macOS
    // could be parked on the wrong loopback family while the browser delivered
    // the callback to the other one.
    for listener in &listeners {
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking: {e}"))?;
    }

    let deadline = std::time::Instant::now() + IDLE_TIMEOUT;

    loop {
        if cancelled.load(Ordering::SeqCst) {
            eprintln!("[oauth] listener cancelled");
            return Err("Sign-in was cancelled.".into());
        }

        if std::time::Instant::now() > deadline {
            eprintln!("[oauth] listener timed out waiting for callback");
            return Err("Timed out waiting for sign-in (5 minutes).".into());
        }

        for listener in &listeners {
            match listener.accept() {
                Ok((mut stream, addr)) => {
                    eprintln!("[oauth] callback received from {addr}");
                    let request = match read_request_line(&mut stream, &cancelled) {
                        Ok(request) => request,
                        Err(_) => continue,
                    };

                    match parse_callback(&request) {
                        Some((_code, _state, Some(error))) => {
                            let reason = format!("Provider error: {error}");
                            eprintln!("[oauth] callback rejected — {reason}");
                            write_response(
                                &mut stream,
                                "400 Bad Request",
                                &error_html(&reason),
                            );
                            return Err(structured_error(
                                "OAUTH_PROVIDER_ERROR",
                                "Sign-in was cancelled or denied. Retry when you are ready.",
                            ));
                        }
                        Some((code, state, None)) => {
                            if state != expected_state {
                                let reason = format!(
                                    "State mismatch: expected {} got {}",
                                    expected_state, state
                                );
                                eprintln!("[oauth] callback rejected — {reason}");
                                write_response(
                                    &mut stream,
                                    "400 Bad Request",
                                    &error_html(&reason),
                                );
                                return Err("OAuth state mismatch — possible CSRF, aborting.".into());
                            }
                            eprintln!("[oauth] callback accepted — code length {}", code.len());
                            write_response(&mut stream, "200 OK", SUCCESS_HTML);
                            return Ok(OAuthResult { code });
                        }
                        None => {
                            write_response(
                                &mut stream,
                                "404 Not Found",
                                "<!doctype html><title>404</title>",
                            );
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(e) => return Err(format!("accept failed: {e}")),
            }
        }

        // Nothing ready on any listener this pass — yield briefly so the loop
        // doesn't busy-spin between deadline and cancellation checks.
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn start_loopback_listener(listeners: Vec<TcpListener>, state: String) -> PendingListener {
    let cancelled = Arc::new(AtomicBool::new(false));
    let listener_cancelled = Arc::clone(&cancelled);
    let listener_state = state.clone();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _ = sender.send(receive_loopback_callback(
            listeners,
            listener_state,
            listener_cancelled,
        ));
    });

    PendingListener {
        state,
        cancelled,
        result: Some(receiver),
        thread: Some(thread),
    }
}

fn cancel_pending_listener(expected_state: Option<&str>) -> Result<bool, String> {
    let pending = {
        let mut guard = listener_store()
            .lock()
            .map_err(|e| format!("Listener lock poisoned: {e}"))?;
        match guard.as_ref() {
            Some(pending) if expected_state.map_or(true, |state| pending.state == state) => {
                guard.take()
            }
            _ => None,
        }
    };

    if let Some(mut pending) = pending {
        pending.cancelled.store(true, Ordering::SeqCst);
        if let Some(thread) = pending.thread.take() {
            thread
                .join()
                .map_err(|_| "OAuth listener thread panicked while cancelling".to_string())?;
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

/// JSON-encode a structured error the frontend can pattern-match on `code`
/// (see `onboarding-signin.ts::mapSignInError`). Falls back to a plain
/// string in the (unreachable in practice) case serialization itself fails.
fn structured_error(code: &str, message: &str) -> String {
    serde_json::json!({ "code": code, "message": message }).to_string()
}

// ── Public types ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct OAuthResult {
    pub code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthFlowInit {
    pub authorize_url: String,
    pub state: String,
}

// ── Cognito token exchange response ────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: i64,
}

// ── HTML ───────────────────────────────────────────────────────────────

const SUCCESS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Signed in — HQ</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #0a0a0a; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Geist", sans-serif; }
  .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
  .card { max-width: 420px; padding: 32px 28px; text-align: center; }
  .check { width: 56px; height: 56px; border-radius: 28px; background: rgba(34,197,94,0.15);
    color: #22c55e; font-size: 28px; line-height: 56px; margin: 0 auto 16px; }
  h1 { font-size: 20px; font-weight: 500; margin: 0 0 8px; }
  p { font-size: 14px; color: #a1a1aa; margin: 0; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="check">&check;</div>
  <h1>You are signed in</h1>
  <p>You can close this tab and return to HQ.</p>
</div></div>
</body>
</html>"#;

fn error_html(reason: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Sign-in error</title>
<style>body{{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;
text-align:center;padding-top:80px}}h1{{font-weight:500}}p{{color:#a1a1aa}}
code{{color:#f87171;font-size:12px;display:block;margin-top:24px}}</style>
</head><body><h1>Sign-in error</h1>
<p>Return to HQ and try again.</p>
<code>{reason}</code></body></html>"#,
        reason = reason
    )
}

// ── HTTP helpers ───────────────────────────────────────────────────────

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        status = status,
        len = body.len(),
        body = body,
    );
    let _ = stream.set_nonblocking(false);
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

// ── Tauri commands ─────────────────────────────────────────────────────

/// Start the OAuth login flow: bind the loopback listener, generate the
/// PKCE verifier/challenge, build the Cognito authorize URL, and store both
/// the listener and the verifier for the later steps.
///
/// Binding the listener here — before the frontend ever opens a browser —
/// closes a race where a very fast provider redirect could reach
/// 127.0.0.1:53682 before `oauth_listen_for_code` got around to binding it.
/// It also surfaces a port-in-use conflict immediately, instead of after
/// the user has already been sent to the provider's sign-in page.
#[tauri::command]
pub async fn start_oauth_login(provider: String) -> Result<OAuthFlowInit, String> {
    let identity_provider = cognito_identity_provider(&provider)?;
    let state = uuid::Uuid::new_v4().to_string();
    let verifier = generate_code_verifier();
    let challenge = compute_code_challenge(&verifier);

    // A Retry replaces any preceding browser attempt. Wait for the old
    // listener thread to relinquish its sockets before binding the new one so
    // the fixed callback port is immediately reusable.
    cancel_pending_listener(None)?;

    let listeners = bind_loopback_listeners(LOOPBACK_PORT).map_err(|e| {
        structured_error(
            "OAUTH_PORT_IN_USE",
            &format!(
                "Sign-in needs local port {LOOPBACK_PORT}, but another process is already \
                 using it ({e}). Close the other sign-in window or app using that port, \
                 then retry."
            ),
        )
    })?;

    // Start accepting before returning the authorize URL. This makes both
    // localhost address families ready before the frontend can open a browser.
    {
        let mut guard = listener_store()
            .lock()
            .map_err(|e| format!("Listener lock poisoned: {e}"))?;
        *guard = Some(start_loopback_listener(listeners, state.clone()));
    }
    eprintln!("[oauth] listener ready; opening provider is now safe");

    // Store verifier for oauth_exchange_code
    {
        let mut guard = pkce_store()
            .lock()
            .map_err(|e| format!("PKCE lock poisoned: {e}"))?;
        *guard = Some(verifier);
    }

    // Explicit identity_provider tells Cognito Hosted UI to skip its own
    // username/password form and redirect straight to the selected provider.
    let authorize_url = build_authorize_url(&state, &challenge, identity_provider);

    Ok(OAuthFlowInit {
        authorize_url,
        state,
    })
}

/// Cancel an in-flight OAuth attempt, wait for its listener thread to release
/// both loopback sockets, and clear the one-shot PKCE verifier.
#[tauri::command]
pub fn oauth_cancel_listen(state: Option<String>) -> Result<(), String> {
    let cancelled = cancel_pending_listener(state.as_deref())?;
    if cancelled || state.is_none() {
        if let Ok(mut guard) = pkce_store().lock() {
            *guard = None;
        }
    }
    eprintln!("[oauth] sign-in cancelled");
    Ok(())
}

/// Exchange an authorization code for tokens using the stored PKCE verifier.
#[tauri::command]
pub async fn oauth_exchange_code(code: String) -> Result<AuthState, String> {
    // Take the verifier out of storage (one-time use)
    let verifier = {
        let mut guard = pkce_store()
            .lock()
            .map_err(|e| format!("PKCE lock poisoned: {e}"))?;
        guard
            .take()
            .ok_or_else(|| "No PKCE verifier found — was start_oauth_login called?".to_string())?
    };

    let client = crate::util::client_info::build_client();

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", COGNITO_CLIENT_ID),
        ("code", &code),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", &verifier),
    ];

    eprintln!("[oauth] token exchange started");
    let response = client
        .post(cognito_token_url())
        .form(&params)
        .send()
        .await
        .map_err(|e| {
            eprintln!("[oauth] token exchange request failed: {e}");
            format!("Token exchange request failed: {e}")
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        eprintln!("[oauth] token exchange rejected with {status}");
        return Err(format!("Token exchange failed ({status}): {body_text}"));
    }

    let token_resp: TokenResponse = response
        .json()
        .await
        .map_err(|e| {
            eprintln!("[oauth] token exchange response parse failed: {e}");
            format!("Failed to parse token response: {e}")
        })?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let expires_at = now_ms + (token_resp.expires_in * 1000);

    let tokens = CognitoTokens {
        access_token: token_resp.access_token,
        id_token: token_resp.id_token,
        refresh_token: token_resp
            .refresh_token
            .ok_or_else(|| "No refresh_token in response".to_string())?,
        expires_at,
    };

    cognito::set_tokens(&tokens).await?;
    eprintln!("[oauth] token exchange completed");

    Ok(AuthState {
        authenticated: true,
        expires_at: Some(cognito::expires_at_iso(&tokens)),
    })
}

/// Wait on the loopback listener bound by `start_oauth_login` for the OAuth
/// callback. Does not bind a socket itself — `start_oauth_login` already did
/// that — so calling this without a preceding, still-pending
/// `start_oauth_login` is a programmer error, not a runtime race.
#[tauri::command]
pub async fn oauth_listen_for_code(state: String) -> Result<OAuthResult, String> {
    let receiver = {
        let mut guard = listener_store()
            .lock()
            .map_err(|e| format!("Listener lock poisoned: {e}"))?;
        let pending = guard.as_mut().ok_or_else(|| {
            "No pending sign-in listener — was start_oauth_login called?".to_string()
        })?;
        if pending.state != state {
            return Err("OAuth state does not match the pending sign-in attempt.".into());
        }
        pending.result.take().ok_or_else(|| {
            "OAuth listener is already waiting for a callback.".to_string()
        })?
    };

    let result = tokio::task::spawn_blocking(move || {
        receiver.recv().unwrap_or_else(|_| {
            Err("OAuth listener was cancelled before the callback arrived.".into())
        })
    })
    .await
    .map_err(|e| format!("OAuth listener task panicked: {e}"))?;

    let thread = {
        let mut guard = listener_store()
            .lock()
            .map_err(|e| format!("Listener lock poisoned: {e}"))?;
        match guard.as_ref() {
            Some(pending) if pending.state == state && pending.result.is_none() => {
                guard.take().and_then(|mut pending| pending.thread.take())
            }
            _ => None,
        }
    };
    if let Some(thread) = thread {
        thread
            .join()
            .map_err(|_| "OAuth listener thread panicked".to_string())?;
    }

    result
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // The listener_store tests mutate a process-global singleton, so cargo's
    // parallel runner can otherwise let them observe each other's writes.
    // Serialize them behind this lock and each leaves the store empty.
    static STORE_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn pkce_store_roundtrip() {
        // Store a verifier, then take it out
        {
            let mut guard = pkce_store().lock().unwrap();
            *guard = Some("test-verifier".to_string());
        }
        {
            let mut guard = pkce_store().lock().unwrap();
            let taken = guard.take();
            assert_eq!(taken, Some("test-verifier".to_string()));
        }
        {
            let guard = pkce_store().lock().unwrap();
            assert!(guard.is_none());
        }
    }

    #[test]
    fn structured_error_encodes_code_and_message() {
        let json = structured_error("OAUTH_PORT_IN_USE", "port busy");
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["code"], "OAUTH_PORT_IN_USE");
        assert_eq!(parsed["message"], "port busy");
    }

    #[test]
    fn structured_error_matches_frontend_contract_shape() {
        // Mirrors what onboarding-signin.test.ts feeds into mapSignInError —
        // if this drifts (field names, nesting), the frontend's structured
        // branch silently stops matching and falls back to raw text.
        let json = structured_error("OAUTH_PROVIDER_ERROR", "The sign-in was denied.");
        assert_eq!(
            json,
            r#"{"code":"OAUTH_PROVIDER_ERROR","message":"The sign-in was denied."}"#
        );
    }

    #[test]
    fn listener_store_roundtrip() {
        let _serialize = STORE_TEST_LOCK.lock().unwrap();
        // Exercises the same store-and-take lifecycle start_oauth_login /
        // oauth_listen_for_code use, on an OS-assigned ephemeral port so this
        // test can't collide with a real running app on 53682.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let pending = start_loopback_listener(vec![listener], "roundtrip".to_string());

        {
            let mut guard = listener_store().lock().unwrap();
            *guard = Some(pending);
        }
        let mut taken = {
            let mut guard = listener_store().lock().unwrap();
            guard.take()
        }
        .unwrap();
        assert_eq!(taken.state, "roundtrip");
        taken.cancelled.store(true, Ordering::SeqCst);
        taken.thread.take().unwrap().join().unwrap();
        {
            let guard = listener_store().lock().unwrap();
            assert!(guard.is_none());
        }
    }

    #[test]
    fn listener_store_replacing_pending_listener_drops_the_old_one() {
        let _serialize = STORE_TEST_LOCK.lock().unwrap();
        // Simulates: user clicks a provider button, abandons that attempt,
        // clicks again. The second start_oauth_login must release the old
        // thread and sockets before it stores a fresh listener.
        let first = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let second = TcpListener::bind(("127.0.0.1", 0)).unwrap();

        {
            let mut guard = listener_store().lock().unwrap();
            *guard = Some(start_loopback_listener(vec![first], "first".to_string()));
        }
        cancel_pending_listener(None).unwrap();
        {
            let mut guard = listener_store().lock().unwrap();
            *guard = Some(start_loopback_listener(vec![second], "second".to_string()));
        }
        {
            let guard = listener_store().lock().unwrap();
            assert_eq!(guard.as_ref().unwrap().state, "second");
        }
        // Leave the process-global store empty for any other test.
        cancel_pending_listener(None).unwrap();
    }

    #[test]
    fn bind_loopback_listeners_binds_ipv4_and_when_available_ipv6_same_port() {
        // The regression this guards: binding IPv4 only lets a `localhost`
        // callback that resolves to `::1` (common on macOS) hit a dead port.
        let ipv6_loopback_available = TcpListener::bind((IPV6_LOOPBACK_HOST, 0)).is_ok();
        let listeners = bind_loopback_listeners(0).expect("bind loopback listeners");
        assert!(!listeners.is_empty());

        let port = listeners
            .iter()
            .find_map(|listener| {
                let addr = listener.local_addr().ok()?;
                addr.ip().is_ipv4().then_some(addr.port())
            })
            .expect("IPv4 loopback listener should always bind");
        TcpStream::connect((LOOPBACK_HOST, port)).expect("connect to IPv4 loopback listener");

        if ipv6_loopback_available {
            assert!(
                listeners
                    .iter()
                    .filter_map(|listener| listener.local_addr().ok())
                    .any(|addr| addr.ip().is_ipv6() && addr.port() == port),
                "IPv6 loopback listener should bind on the same port as IPv4"
            );
            TcpStream::connect((IPV6_LOOPBACK_HOST, port))
                .expect("connect to IPv6 loopback listener");
        }
    }

    #[test]
    fn listener_is_ready_before_the_provider_can_open() {
        // The authorize URL is returned only after start_loopback_listener
        // returns. This guards the original race: a fast browser redirect must
        // be accepted even when oauth_listen_for_code has not run yet.
        let listeners = bind_loopback_listeners(0).expect("bind loopback listeners");
        let port = listeners[0].local_addr().unwrap().port();
        let mut pending = start_loopback_listener(listeners, "test-state".to_string());

        let mut callback = TcpStream::connect((LOOPBACK_HOST, port))
            .expect("the callback listener is ready before opening the provider");
        callback
            .write_all(
                b"GET /callback?code=test-code&state=test-state HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            .unwrap();

        let result = pending
            .result
            .take()
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .expect("callback result");
        assert_eq!(result.unwrap().code, "test-code");
        pending.thread.take().unwrap().join().unwrap();
    }
}
