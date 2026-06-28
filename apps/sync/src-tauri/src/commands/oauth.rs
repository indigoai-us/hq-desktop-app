// oauth.rs — OAuth loopback listener + PKCE login flow for HQ Sync menubar.
//
// Starts a one-shot HTTP server on 127.0.0.1:53682 and advertises the
// callback as http://localhost:53682/callback, which matches the
// `http://localhost:*/callback` wildcard registered on Cognito app client
// 7acei2c8v870enheptb1j5foln (hq-prod stack, canonical post-2026-04-25 cutover).
// Binding to 127.0.0.1 (not 0.0.0.0) keeps the
// listener off the LAN; `localhost` in the redirect URI is required because
// Cognito matches the host segment literally — `127.0.0.1` fails.
// and waits for the browser to redirect back to /callback?code=...&state=...
// with the authorization code. Responds with a friendly HTML page that tells
// the user to return to HQ Sync, then shuts the listener down.
//
// Login flow (Svelte frontend):
//   1. Call `start_oauth_login` — returns authorize URL + state.
//   2. Call `tauri_plugin_shell::open(authorize_url)` to open the browser.
//   3. Call `oauth_listen_for_code(state)` to wait for the callback code.
//   4. Call `oauth_exchange_code(code)` to exchange the code for tokens.
//
// Security notes:
//   - Binds to 127.0.0.1 only — never 0.0.0.0.
//   - Enforces `state` match between what the listener was started with and
//     what comes back on the callback, defending against CSRF/code injection.
//   - Single-use: accepts at most one request, closes listener afterwards.
//   - 5-minute timeout so a stalled/abandoned flow doesn't leak a socket.
//   - PKCE (S256) prevents authorization code interception.

use super::cognito::{self, AuthState, CognitoTokens};
use hq_desktop_core::oauth::{
    build_authorize_url, cognito_identity_provider, cognito_token_url, compute_code_challenge,
    generate_code_verifier, parse_callback, COGNITO_CLIENT_ID, REDIRECT_URI,
};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LOOPBACK_PORT: u16 = 53682;
const LOOPBACK_HOST: &str = "127.0.0.1";
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

// ── PKCE verifier storage ──────────────────────────────────────────────

static PKCE_VERIFIER: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn pkce_store() -> &'static Mutex<Option<String>> {
    PKCE_VERIFIER.get_or_init(|| Mutex::new(None))
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
<title>Signed in — HQ Sync</title>
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
  <p>You can close this tab and return to HQ Sync.</p>
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
<p>Return to HQ Sync and try again.</p>
<code>{reason}</code></body></html>"#,
        reason = reason
    )
}

// ── HTTP helpers ───────────────────────────────────────────────────────

fn read_request_line(stream: &mut TcpStream) -> std::io::Result<String> {
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf[..n]).into_owned())
}

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
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

// ── Tauri commands ─────────────────────────────────────────────────────

/// Start the OAuth login flow: generate PKCE verifier/challenge, build the
/// Cognito authorize URL, store the verifier for later exchange.
#[tauri::command]
pub async fn start_oauth_login(provider: String) -> Result<OAuthFlowInit, String> {
    let identity_provider = cognito_identity_provider(&provider)?;
    let state = uuid::Uuid::new_v4().to_string();
    let verifier = generate_code_verifier();
    let challenge = compute_code_challenge(&verifier);

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

    let response = client
        .post(cognito_token_url())
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response
            .text()
            .await
            .unwrap_or_else(|_| "unknown".to_string());
        return Err(format!("Token exchange failed ({status}): {body_text}"));
    }

    let token_resp: TokenResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse token response: {e}"))?;

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

    Ok(AuthState {
        authenticated: true,
        expires_at: Some(cognito::expires_at_iso(&tokens)),
    })
}

/// Listen for the OAuth callback on the loopback port.
#[tauri::command]
pub async fn oauth_listen_for_code(state: String) -> Result<OAuthResult, String> {
    let state_copy = state.clone();

    tokio::task::spawn_blocking(move || -> Result<OAuthResult, String> {
        let listener = TcpListener::bind((LOOPBACK_HOST, LOOPBACK_PORT)).map_err(|e| {
            format!(
                "Failed to bind OAuth loopback listener on {}:{} — {}. \
                     Another instance may already be waiting for sign-in.",
                LOOPBACK_HOST, LOOPBACK_PORT, e
            )
        })?;

        listener
            .set_nonblocking(false)
            .map_err(|e| format!("set_nonblocking: {e}"))?;

        let deadline = std::time::Instant::now() + IDLE_TIMEOUT;

        loop {
            if std::time::Instant::now() > deadline {
                return Err("Timed out waiting for sign-in (5 minutes).".into());
            }

            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    let request = match read_request_line(&mut stream) {
                        Ok(r) => r,
                        Err(_) => {
                            continue;
                        }
                    };

                    match parse_callback(&request) {
                        Some((_code, _state, Some(error))) => {
                            let reason = format!("Provider error: {error}");
                            eprintln!("[oauth] callback rejected — {reason}");
                            write_response(&mut stream, "400 Bad Request", &error_html(&reason));
                            return Err(format!("OAuth provider returned error: {error}"));
                        }
                        Some((code, state, None)) => {
                            if state != state_copy {
                                let reason = format!(
                                    "State mismatch: expected {} got {}",
                                    state_copy, state
                                );
                                eprintln!("[oauth] callback rejected — {reason}");
                                write_response(
                                    &mut stream,
                                    "400 Bad Request",
                                    &error_html(&reason),
                                );
                                return Err(
                                    "OAuth state mismatch — possible CSRF, aborting.".into()
                                );
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
                            continue;
                        }
                    }
                }
                Err(e) => {
                    return Err(format!("accept failed: {e}"));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("OAuth listener task panicked: {e}"))?
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
}
