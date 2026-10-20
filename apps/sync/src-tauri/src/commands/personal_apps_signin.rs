// personal_apps_signin.rs — catch a personal-app sign-in on this Mac.
//
// Some MCP apps (Vercel, Asana, CircleCI, Dropbox, ...) refuse HQ's public
// sign-in return page but accept a return to `localhost`, the way Claude Code
// and Cursor sign in. For those apps HQ's server registers the bot's sign-in
// with REDIRECT_URI below; this module listens there for the one redirect,
// shows a "you're signed in" page, and hands code/state/iss back to the
// frontend, which posts them to HQ (personalApps.completeSignIn). HQ checks
// the state against the owner's pending sign-in and relays it to the bot,
// which holds the PKCE verifier and keeps the tokens. Nothing here sees a
// token.
//
// Flow (frontend, packages/platform personal-apps.ts):
//   1. `personal_apps_signin_listen(state)` binds the loopback listener BEFORE
//      the browser opens, so a fast redirect cannot beat it, and surfaces a
//      busy port at once.
//   2. Open the provider page.
//   3. `personal_apps_signin_wait(state)` blocks until the redirect arrives,
//      the 5-minute window ends, or `personal_apps_signin_cancel` runs.
//
// Same guarantees as the HQ login listener in oauth.rs: loopback only
// (127.0.0.1 and ::1, because macOS often resolves `localhost` to ::1 first),
// state must match before anything is acted on, single use, 5-minute timeout.
// Its own port and path so it never collides with an HQ login in progress.

use hq_desktop_core::oauth::bind_loopback_listeners;
use serde::Serialize;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Must match LOCAL_SIGN_IN_REDIRECT_URI in hq-pro-agents personal-apps.ts.
pub const REDIRECT_URI: &str = "http://localhost:53689/personal-apps/callback";
const PORT: u16 = 53689;
const CALLBACK_PATH: &str = "/personal-apps/callback";
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REQUEST_BYTES: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalAppCallback {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iss: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Rejection {
    NotOurs,
    TooLarge,
}

struct Pending {
    state: String,
    cancelled: Arc<AtomicBool>,
    result: Option<mpsc::Receiver<Result<PersonalAppCallback, String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();

fn pending_store() -> &'static Mutex<Option<Pending>> {
    PENDING.get_or_init(|| Mutex::new(None))
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let hex = std::str::from_utf8(hex).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            byte => out.push(byte),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// Parse the browser's request line. Only `GET /personal-apps/callback?...`
/// with a state is ours; anything else is answered and ignored.
fn parse_request(request: &str) -> Result<PersonalAppCallback, Rejection> {
    if request.len() > MAX_REQUEST_BYTES {
        return Err(Rejection::TooLarge);
    }
    let first = request.lines().next().ok_or(Rejection::NotOurs)?;
    let mut parts = first.split_whitespace();
    if parts.next() != Some("GET") {
        return Err(Rejection::NotOurs);
    }
    let target = parts.next().ok_or(Rejection::NotOurs)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != CALLBACK_PATH {
        return Err(Rejection::NotOurs);
    }
    let mut callback = PersonalAppCallback { state: String::new(), code: None, error: None, iss: None };
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (key, raw) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(raw).ok_or(Rejection::NotOurs)?;
        if value.is_empty() {
            continue;
        }
        match key {
            "state" => callback.state = value,
            "code" => callback.code = Some(value),
            "error" => callback.error = Some(value),
            "iss" => callback.iss = Some(value),
            _ => {}
        }
    }
    if callback.state.is_empty() || (callback.code.is_none() && callback.error.is_none()) {
        return Err(Rejection::NotOurs);
    }
    Ok(callback)
}

fn read_request(stream: &mut TcpStream, cancelled: &AtomicBool) -> std::io::Result<String> {
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut buf = [0u8; MAX_REQUEST_BYTES];
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
        match stream.read(&mut buf) {
            Ok(n) => return Ok(String::from_utf8_lossy(&buf[..n]).into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "no request"));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
}

fn page(title: &str, body: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>{title} — HQ</title>
<style>html,body{{margin:0;height:100%;background:#0a0a0a;color:#fafafa;font-family:-apple-system,BlinkMacSystemFont,sans-serif}}
.wrap{{height:100%;display:flex;align-items:center;justify-content:center}}.card{{max-width:420px;padding:32px 28px;text-align:center}}
h1{{font-size:20px;font-weight:500;margin:0 0 8px}}p{{font-size:14px;color:#a1a1aa;margin:0}}</style></head>
<body><div class="wrap"><div class="card"><h1>{title}</h1><p>{body}</p></div></div>
<script>try {{ history.replaceState(null, "", "/"); }} catch (_) {{}}</script></body></html>"#
    )
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let payload = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n\
         Referrer-Policy: no-referrer\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len(),
    );
    let _ = stream.set_nonblocking(false);
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

fn receive(
    listeners: Vec<TcpListener>,
    expected_state: String,
    cancelled: Arc<AtomicBool>,
) -> Result<PersonalAppCallback, String> {
    for listener in &listeners {
        listener.set_nonblocking(true).map_err(|e| format!("set_nonblocking: {e}"))?;
    }
    let deadline = Instant::now() + IDLE_TIMEOUT;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Sign-in was cancelled.".into());
        }
        if Instant::now() > deadline {
            return Err("Sign-in was not finished in time.".into());
        }
        for listener in &listeners {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let Ok(request) = read_request(&mut stream, &cancelled) else { continue };
                    match parse_request(&request) {
                        // Another attempt's (or a forged) redirect must not end this one.
                        Ok(callback) if callback.state != expected_state => respond(
                            &mut stream,
                            "400 Bad Request",
                            &page("This sign-in link has expired", "Go back to HQ and start the sign-in again."),
                        ),
                        Ok(callback) => {
                            let (title, body) = if callback.error.is_some() {
                                ("Sign-in was cancelled", "Nothing was connected. You can close this tab and go back to HQ.")
                            } else {
                                ("You're signed in", "Your bot is finishing the connection. You can close this tab and go back to HQ.")
                            };
                            respond(&mut stream, "200 OK", &page(title, body));
                            return Ok(callback);
                        }
                        Err(Rejection::TooLarge) => respond(&mut stream, "400 Bad Request", "<!doctype html><title>HQ</title>"),
                        Err(Rejection::NotOurs) => respond(&mut stream, "404 Not Found", "<!doctype html><title>HQ</title>"),
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
                Err(e) => return Err(format!("accept failed: {e}")),
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn cancel_pending(expected_state: Option<&str>) -> bool {
    let pending = {
        let mut guard = pending_store().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_ref() {
            Some(p) if expected_state.map_or(true, |state| p.state == state) => guard.take(),
            _ => None,
        }
    };
    let Some(mut pending) = pending else { return false };
    pending.cancelled.store(true, Ordering::SeqCst);
    if let Some(thread) = pending.thread.take() {
        let _ = thread.join();
    }
    true
}

fn valid_state(state: &str) -> bool {
    !state.is_empty() && state.len() <= 512 && state.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Bind the listener for one sign-in. Replaces any earlier personal-app
/// sign-in still waiting (one browser sign-in at a time).
#[tauri::command]
pub fn personal_apps_signin_listen(state: String) -> Result<String, String> {
    if !valid_state(&state) {
        return Err("PERSONAL_APP_SIGNIN_BAD_STATE".into());
    }
    cancel_pending(None);
    let listeners = bind_loopback_listeners(&[PORT]).map_err(|_| "PERSONAL_APP_SIGNIN_PORT_IN_USE".to_string())?;
    let cancelled = Arc::new(AtomicBool::new(false));
    let thread_cancelled = Arc::clone(&cancelled);
    let thread_state = state.clone();
    let (sender, receiver) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _ = sender.send(receive(listeners, thread_state, thread_cancelled));
    });
    *pending_store().lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Pending {
        state,
        cancelled,
        result: Some(receiver),
        thread: Some(thread),
    });
    Ok(REDIRECT_URI.to_string())
}

/// Wait for the redirect bound by `personal_apps_signin_listen`.
#[tauri::command]
pub async fn personal_apps_signin_wait(state: String) -> Result<PersonalAppCallback, String> {
    let receiver = {
        let mut guard = pending_store().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match guard.as_mut() {
            Some(p) if p.state == state => p.result.take(),
            _ => None,
        }
    }
    .ok_or_else(|| "No sign-in is waiting.".to_string())?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        receiver.recv().unwrap_or_else(|_| Err("Sign-in listener stopped.".into()))
    })
    .await
    .map_err(|e| format!("join: {e}"))?;
    let mut guard = pending_store().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.as_ref().is_some_and(|p| p.state == state) {
        if let Some(mut done) = guard.take() {
            if let Some(thread) = done.thread.take() {
                let _ = thread.join();
            }
        }
    }
    outcome
}

#[tauri::command]
pub fn personal_apps_signin_cancel(state: Option<String>) -> Result<bool, String> {
    Ok(cancel_pending(state.as_deref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_code_redirect_with_iss() {
        let got = parse_request(
            "GET /personal-apps/callback?code=abc%2B1&state=S1&iss=https%3A%2F%2Fvercel.com HTTP/1.1\r\nHost: localhost\r\n\r\n",
        )
        .unwrap();
        assert_eq!(
            got,
            PersonalAppCallback {
                state: "S1".into(),
                code: Some("abc+1".into()),
                error: None,
                iss: Some("https://vercel.com".into())
            }
        );
    }

    #[test]
    fn parses_a_provider_refusal() {
        let got = parse_request("GET /personal-apps/callback?error=access_denied&state=S1 HTTP/1.1\r\n\r\n").unwrap();
        assert_eq!(got.error.as_deref(), Some("access_denied"));
        assert!(got.code.is_none());
    }

    #[test]
    fn ignores_everything_that_is_not_our_callback() {
        for request in [
            "GET /callback?code=a&state=S1 HTTP/1.1\r\n\r\n",
            "POST /personal-apps/callback?code=a&state=S1 HTTP/1.1\r\n\r\n",
            "GET /personal-apps/callback?code=a HTTP/1.1\r\n\r\n",
            "GET /personal-apps/callback?state=S1 HTTP/1.1\r\n\r\n",
            "GET /personal-apps/callback?code=%zz&state=S1 HTTP/1.1\r\n\r\n",
            "GET /favicon.ico HTTP/1.1\r\n\r\n",
        ] {
            assert_eq!(parse_request(request), Err(Rejection::NotOurs), "{request}");
        }
        assert_eq!(parse_request(&"x".repeat(MAX_REQUEST_BYTES + 1)), Err(Rejection::TooLarge));
    }

    #[test]
    fn redirect_uri_matches_port_and_path() {
        assert_eq!(REDIRECT_URI, format!("http://localhost:{PORT}{CALLBACK_PATH}"));
    }

    #[test]
    fn rejects_states_with_spaces_or_controls() {
        assert!(valid_state("abc-_.~123"));
        assert!(!valid_state(""));
        assert!(!valid_state("a b"));
        assert!(!valid_state("a\nb"));
    }

    #[test]
    fn only_the_matching_state_ends_the_wait() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancelled = Arc::new(AtomicBool::new(false));
        let handle = std::thread::spawn({
            let cancelled = Arc::clone(&cancelled);
            move || receive(vec![listener], "GOOD".into(), cancelled)
        });
        let send = |path: &str| {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
            stream.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes()).unwrap();
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            response
        };
        assert!(send("/personal-apps/callback?code=x&state=BAD").starts_with("HTTP/1.1 400"));
        assert!(send("/personal-apps/callback?code=x&state=GOOD").contains("signed in"));
        let got = handle.join().unwrap().unwrap();
        assert_eq!(got.code.as_deref(), Some("x"));
    }
}
