//! Native OAuth loopback + PKCE command owner.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;

use super::local::CoreBackend;
use crate::{to_value, CancellationFlag, EngineError};

pub(crate) const IMPLEMENTED_METHODS: &[&str] = &[
    "start_oauth_login",
    "oauth_listen_for_code",
    "oauth_cancel_listen",
    "oauth_exchange_code",
];

const PRODUCTION_LOOPBACK_PORT: u16 = 53_682;
const IPV4_LOOPBACK: &str = "127.0.0.1";
const IPV6_LOOPBACK: &str = "::1";
const CALLBACK_POLL_INTERVAL: Duration = Duration::from_millis(20);
const LISTEN_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
struct OAuthConfig {
    port: u16,
    callback_timeout: Duration,
    request_timeout: Duration,
}

impl OAuthConfig {
    fn production() -> Self {
        Self {
            port: PRODUCTION_LOOPBACK_PORT,
            callback_timeout: Duration::from_secs(5 * 60),
            request_timeout: Duration::from_secs(10),
        }
    }

    #[cfg(test)]
    fn for_tests(port: u16, callback_timeout: Duration) -> Self {
        Self {
            port,
            callback_timeout,
            request_timeout: Duration::from_secs(1),
        }
    }
}

#[derive(Debug, Clone)]
struct FormResponse {
    status: u16,
    body: Value,
}

trait FormTransport: Send + Sync {
    fn post_form(
        &self,
        url: &str,
        form: &BTreeMap<String, String>,
        cancellation: &CancellationFlag,
    ) -> Result<FormResponse, EngineError>;
}

trait TokenStore: Send + Sync {
    fn snapshot(&self) -> Result<Option<hq_desktop_core::cognito::CognitoTokens>, EngineError>;

    fn persist(&self, tokens: &hq_desktop_core::cognito::CognitoTokens) -> Result<(), EngineError>;

    fn rollback(
        &self,
        previous: Option<&hq_desktop_core::cognito::CognitoTokens>,
    ) -> Result<(), EngineError>;
}

struct ReqwestFormTransport {
    client: reqwest::blocking::Client,
}

impl ReqwestFormTransport {
    fn new() -> Result<Self, EngineError> {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("HQ-Native/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map(|client| Self { client })
            .map_err(|error| {
                EngineError::new(
                    "oauth_client_unavailable",
                    format!("Could not initialize secure sign-in: {error}"),
                    true,
                )
            })
    }
}

impl FormTransport for ReqwestFormTransport {
    fn post_form(
        &self,
        url: &str,
        form: &BTreeMap<String, String>,
        cancellation: &CancellationFlag,
    ) -> Result<FormResponse, EngineError> {
        cancellation.check()?;
        let response = self.client.post(url).form(form).send().map_err(|error| {
            EngineError::new(
                "oauth_exchange_failed",
                format!("The sign-in service could not be reached: {error}"),
                true,
            )
        })?;
        cancellation.check()?;
        let status = response.status().as_u16();
        let response_body = response.text().map_err(|_| {
            EngineError::new(
                "oauth_invalid_response",
                "The sign-in service returned an unreadable response",
                true,
            )
        })?;
        let body = serde_json::from_str(&response_body).unwrap_or(Value::Null);
        Ok(FormResponse { status, body })
    }
}

struct CognitoTokenStore;

impl TokenStore for CognitoTokenStore {
    fn snapshot(&self) -> Result<Option<hq_desktop_core::cognito::CognitoTokens>, EngineError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "oauth_tokens_snapshot_failed",
                    format!("Could not initialize secure credential storage: {error}"),
                    true,
                )
            })?;
        runtime
            .block_on(hq_desktop_core::cognito::get_tokens())
            .map_err(|message| {
                EngineError::new(
                    "oauth_tokens_snapshot_failed",
                    format!("Existing signed-in credentials could not be read: {message}"),
                    false,
                )
            })
    }

    fn persist(&self, tokens: &hq_desktop_core::cognito::CognitoTokens) -> Result<(), EngineError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "oauth_tokens_persist_failed",
                    format!("Could not initialize secure credential storage: {error}"),
                    true,
                )
            })?;
        runtime
            .block_on(hq_desktop_core::cognito::set_tokens(tokens))
            .map_err(|message| {
                EngineError::new(
                    "oauth_tokens_persist_failed",
                    format!("Signed-in credentials could not be saved: {message}"),
                    false,
                )
            })
    }

    fn rollback(
        &self,
        previous: Option<&hq_desktop_core::cognito::CognitoTokens>,
    ) -> Result<(), EngineError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                EngineError::new(
                    "oauth_tokens_rollback_failed",
                    format!("Could not initialize secure credential rollback: {error}"),
                    true,
                )
            })?;
        let result = match previous {
            Some(tokens) => runtime.block_on(hq_desktop_core::cognito::set_tokens(tokens)),
            None => runtime.block_on(hq_desktop_core::cognito::clear_tokens()),
        };
        result.map_err(|message| {
            EngineError::new(
                "oauth_tokens_rollback_failed",
                format!("Cancelled sign-in credentials could not be rolled back: {message}"),
                false,
            )
        })
    }
}

#[derive(Debug)]
struct PendingListener {
    state: String,
    cancelled: Arc<AtomicBool>,
    result: Option<mpsc::Receiver<Result<OAuthResult, EngineError>>>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct ControllerState {
    pending: Option<PendingListener>,
    verifier: Option<String>,
}

struct OAuthController {
    config: OAuthConfig,
    transport: Arc<dyn FormTransport>,
    token_store: Arc<dyn TokenStore>,
    state: Mutex<ControllerState>,
}

impl OAuthController {
    fn new(
        config: OAuthConfig,
        transport: Arc<dyn FormTransport>,
        token_store: Arc<dyn TokenStore>,
    ) -> Self {
        Self {
            config,
            transport,
            token_store,
            state: Mutex::new(ControllerState::default()),
        }
    }

    fn production() -> Result<Self, EngineError> {
        Ok(Self::new(
            OAuthConfig::production(),
            Arc::new(ReqwestFormTransport::new()?),
            Arc::new(CognitoTokenStore),
        ))
    }

    fn start(
        &self,
        provider: &str,
        cancellation: &CancellationFlag,
    ) -> Result<OAuthFlowInit, EngineError> {
        cancellation.check()?;
        let identity_provider = hq_desktop_core::oauth::cognito_identity_provider(provider)
            .map_err(|_| {
                EngineError::new(
                    "oauth_provider_unsupported",
                    "Choose Google or Microsoft to sign in",
                    false,
                )
            })?;

        self.cancel(None)?;
        cancellation.check()?;

        let state = uuid::Uuid::new_v4().to_string();
        let verifier = hq_desktop_core::oauth::generate_code_verifier();
        let challenge = hq_desktop_core::oauth::compute_code_challenge(&verifier);
        let listeners = bind_loopback_listeners(self.config.port).map_err(|error| {
            EngineError::new(
                "oauth_port_in_use",
                format!(
                    "Sign-in needs local port {}, but it is unavailable: {error}",
                    self.config.port
                ),
                false,
            )
        })?;
        cancellation.check()?;

        let pending = start_loopback_listener(
            listeners,
            state.clone(),
            self.config.callback_timeout,
            self.config.request_timeout,
        )?;
        {
            let mut guard = lock_unpoisoned(&self.state);
            guard.verifier = Some(verifier);
            guard.pending = Some(pending);
        }

        let authorize_url =
            hq_desktop_core::oauth::build_authorize_url(&state, &challenge, identity_provider);
        Ok(OAuthFlowInit {
            authorize_url,
            state,
        })
    }

    fn listen(
        &self,
        expected_state: &str,
        cancellation: &CancellationFlag,
    ) -> Result<OAuthResult, EngineError> {
        if expected_state.trim().is_empty() {
            return Err(EngineError::new(
                "invalid_params",
                "oauth_listen_for_code requires a non-empty `state`",
                false,
            ));
        }

        let receiver = {
            let mut guard = lock_unpoisoned(&self.state);
            let pending = guard.pending.as_mut().ok_or_else(|| {
                EngineError::new(
                    "oauth_not_started",
                    "Start a sign-in attempt before waiting for its callback",
                    false,
                )
            })?;
            if pending.state != expected_state {
                return Err(EngineError::new(
                    "oauth_state_mismatch",
                    "The sign-in callback did not match this attempt",
                    false,
                ));
            }
            pending.result.take().ok_or_else(|| {
                EngineError::new(
                    "oauth_already_waiting",
                    "This sign-in attempt is already waiting for a callback",
                    false,
                )
            })?
        };

        let outcome = loop {
            if cancellation.is_cancelled() {
                self.cancel(Some(expected_state))?;
                return Err(EngineError::cancelled());
            }
            match receiver.recv_timeout(LISTEN_POLL_INTERVAL) {
                Ok(outcome) => break outcome,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err(EngineError::new(
                        "oauth_listener_failed",
                        "The local sign-in listener stopped unexpectedly",
                        true,
                    ));
                }
            }
        };

        if let Some(mut pending) = self.take_pending(Some(expected_state), false) {
            if let Some(worker) = pending.worker.take() {
                worker.join().map_err(|_| {
                    EngineError::new(
                        "oauth_listener_failed",
                        "The local sign-in listener stopped unexpectedly",
                        true,
                    )
                })?;
            }
        }
        outcome
    }

    fn cancel(&self, expected_state: Option<&str>) -> Result<(), EngineError> {
        let Some(mut pending) = self.take_pending(expected_state, true) else {
            if expected_state.is_none() {
                lock_unpoisoned(&self.state).verifier = None;
            }
            return Ok(());
        };

        pending.cancelled.store(true, Ordering::Release);
        if let Some(worker) = pending.worker.take() {
            worker.join().map_err(|_| {
                EngineError::new(
                    "oauth_listener_failed",
                    "The local sign-in listener stopped unexpectedly",
                    true,
                )
            })?;
        }
        Ok(())
    }

    fn exchange(
        &self,
        code: &str,
        cancellation: &CancellationFlag,
    ) -> Result<hq_desktop_core::cognito::AuthState, EngineError> {
        if code.trim().is_empty() {
            return Err(EngineError::new(
                "invalid_params",
                "oauth_exchange_code requires a non-empty `code`",
                false,
            ));
        }
        cancellation.check()?;
        let verifier = lock_unpoisoned(&self.state)
            .verifier
            .take()
            .ok_or_else(|| {
                EngineError::new(
                    "oauth_not_started",
                    "Start a sign-in attempt before exchanging its authorization code",
                    false,
                )
            })?;

        let form = BTreeMap::from([
            ("grant_type".to_string(), "authorization_code".to_string()),
            (
                "client_id".to_string(),
                hq_desktop_core::oauth::COGNITO_CLIENT_ID.to_string(),
            ),
            ("code".to_string(), code.to_string()),
            (
                "redirect_uri".to_string(),
                hq_desktop_core::oauth::REDIRECT_URI.to_string(),
            ),
            ("code_verifier".to_string(), verifier),
        ]);
        let response = self.transport.post_form(
            &hq_desktop_core::oauth::cognito_token_url(),
            &form,
            cancellation,
        )?;
        cancellation.check()?;
        if !(200..300).contains(&response.status) {
            return Err(EngineError::new(
                "oauth_exchange_rejected",
                format!(
                    "The sign-in service rejected the authorization code (HTTP {})",
                    response.status
                ),
                false,
            ));
        }

        let response: TokenResponse = serde_json::from_value(response.body).map_err(|_| {
            EngineError::new(
                "oauth_invalid_response",
                "The sign-in service returned an invalid credential response",
                false,
            )
        })?;
        if response.expires_in <= 0 {
            return Err(EngineError::new(
                "oauth_invalid_response",
                "The sign-in service returned an invalid credential lifetime",
                false,
            ));
        }
        let refresh_token = response.refresh_token.ok_or_else(|| {
            EngineError::new(
                "oauth_invalid_response",
                "The sign-in service did not return a refresh credential",
                false,
            )
        })?;
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(i64::MAX as u128) as i64;
        let lifetime_ms = response.expires_in.checked_mul(1_000).ok_or_else(|| {
            EngineError::new(
                "oauth_invalid_response",
                "The sign-in service returned an invalid credential lifetime",
                false,
            )
        })?;
        let expires_at = now_ms.checked_add(lifetime_ms).ok_or_else(|| {
            EngineError::new(
                "oauth_invalid_response",
                "The sign-in service returned an invalid credential lifetime",
                false,
            )
        })?;
        let tokens = hq_desktop_core::cognito::CognitoTokens {
            access_token: response.access_token,
            id_token: response.id_token,
            refresh_token,
            expires_at,
        };
        let previous_tokens = self.token_store.snapshot()?;
        cancellation.check()?;
        self.token_store.persist(&tokens)?;
        if let Err(cancelled) = cancellation.check() {
            self.token_store.rollback(previous_tokens.as_ref())?;
            return Err(cancelled);
        }

        Ok(hq_desktop_core::cognito::AuthState {
            authenticated: true,
            expires_at: Some(hq_desktop_core::cognito::expires_at_iso(&tokens)),
        })
    }

    fn take_pending(
        &self,
        expected_state: Option<&str>,
        clear_verifier: bool,
    ) -> Option<PendingListener> {
        let mut guard = lock_unpoisoned(&self.state);
        let matches = guard
            .pending
            .as_ref()
            .is_some_and(|pending| expected_state.is_none_or(|state| pending.state == state));
        if matches {
            if clear_verifier {
                guard.verifier = None;
            }
            guard.pending.take()
        } else {
            None
        }
    }

    #[cfg(test)]
    fn install_verifier_for_test(&self, verifier: &str) {
        lock_unpoisoned(&self.state).verifier = Some(verifier.to_string());
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthFlowInit {
    authorize_url: String,
    state: String,
}

#[derive(Debug, serde::Serialize)]
struct OAuthResult {
    code: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    id_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: i64,
}

#[derive(Debug)]
struct ParsedCallback {
    code: Option<String>,
    state: Option<String>,
    provider_error: Option<String>,
}

fn bind_loopback_listeners(port: u16) -> std::io::Result<Vec<TcpListener>> {
    let mut listeners = Vec::with_capacity(2);
    let mut first_error = None;
    let mut selected_port = port;

    match TcpListener::bind((IPV4_LOOPBACK, port)) {
        Ok(listener) => {
            selected_port = listener.local_addr()?.port();
            listeners.push(listener);
        }
        Err(error) => first_error = Some(error),
    }
    match TcpListener::bind((IPV6_LOOPBACK, selected_port)) {
        Ok(listener) => listeners.push(listener),
        Err(error) if first_error.is_none() => first_error = Some(error),
        Err(_) => {}
    }

    if listeners.is_empty() {
        Err(first_error.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::AddrNotAvailable,
                "no loopback interface is available",
            )
        }))
    } else {
        Ok(listeners)
    }
}

fn start_loopback_listener(
    listeners: Vec<TcpListener>,
    expected_state: String,
    callback_timeout: Duration,
    request_timeout: Duration,
) -> Result<PendingListener, EngineError> {
    for listener in &listeners {
        listener.set_nonblocking(true).map_err(|error| {
            EngineError::new(
                "oauth_listener_failed",
                format!("Could not prepare the local sign-in listener: {error}"),
                true,
            )
        })?;
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    let worker_cancelled = Arc::clone(&cancelled);
    let worker_state = expected_state.clone();
    let (sender, receiver) = mpsc::channel();
    let worker = std::thread::Builder::new()
        .name("hq-oauth-loopback".to_string())
        .spawn(move || {
            let _ = sender.send(receive_loopback_callback(
                listeners,
                &worker_state,
                &worker_cancelled,
                callback_timeout,
                request_timeout,
            ));
        })
        .map_err(|error| {
            EngineError::new(
                "oauth_listener_failed",
                format!("Could not start the local sign-in listener: {error}"),
                true,
            )
        })?;

    Ok(PendingListener {
        state: expected_state,
        cancelled,
        result: Some(receiver),
        worker: Some(worker),
    })
}

fn receive_loopback_callback(
    listeners: Vec<TcpListener>,
    expected_state: &str,
    cancelled: &AtomicBool,
    callback_timeout: Duration,
    request_timeout: Duration,
) -> Result<OAuthResult, EngineError> {
    let deadline = Instant::now() + callback_timeout;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(EngineError::new(
                "oauth_cancelled",
                "Sign-in was cancelled",
                false,
            ));
        }
        if Instant::now() >= deadline {
            return Err(EngineError::new(
                "oauth_timeout",
                "Sign-in timed out while waiting for the browser",
                true,
            ));
        }

        for listener in &listeners {
            match listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let request = match read_request(&mut stream, cancelled, request_timeout) {
                        Ok(request) => request,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                            return Err(EngineError::new(
                                "oauth_cancelled",
                                "Sign-in was cancelled",
                                false,
                            ));
                        }
                        Err(_) => {
                            write_response(&mut stream, "408 Request Timeout", ERROR_HTML);
                            continue;
                        }
                    };
                    let Some(callback) = parse_callback_request(&request) else {
                        write_response(&mut stream, "404 Not Found", NOT_FOUND_HTML);
                        continue;
                    };
                    if callback.provider_error.is_some() {
                        write_response(&mut stream, "400 Bad Request", ERROR_HTML);
                        return Err(EngineError::new(
                            "oauth_provider_error",
                            "Sign-in was cancelled or denied by the provider",
                            false,
                        ));
                    }
                    if callback.state.as_deref() != Some(expected_state) {
                        write_response(&mut stream, "400 Bad Request", ERROR_HTML);
                        return Err(EngineError::new(
                            "oauth_state_mismatch",
                            "The sign-in callback did not match this attempt",
                            false,
                        ));
                    }
                    let code = callback
                        .code
                        .filter(|code| !code.trim().is_empty())
                        .ok_or_else(|| {
                            EngineError::new(
                                "oauth_invalid_callback",
                                "The sign-in callback did not include an authorization code",
                                false,
                            )
                        })?;
                    write_response(&mut stream, "200 OK", SUCCESS_HTML);
                    return Ok(OAuthResult { code });
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => {
                    return Err(EngineError::new(
                        "oauth_listener_failed",
                        format!("The local sign-in listener failed: {error}"),
                        true,
                    ));
                }
            }
        }
        std::thread::sleep(CALLBACK_POLL_INTERVAL);
    }
}

fn read_request(
    stream: &mut TcpStream,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> std::io::Result<String> {
    stream.set_nonblocking(true)?;
    let deadline = Instant::now() + timeout;
    let mut request = Vec::with_capacity(1_024);
    let mut chunk = [0_u8; 1_024];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "listener cancelled",
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) if !request.is_empty() => break,
            Ok(0) => {}
            Ok(count) => {
                request.extend_from_slice(&chunk[..count]);
                if request.len() > 8_192 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "callback request is too large",
                    ));
                }
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "callback request timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(String::from_utf8_lossy(&request).into_owned())
}

fn parse_callback_request(request: &str) -> Option<ParsedCallback> {
    let first_line = request.lines().next()?;
    let mut parts = first_line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let target = parts.next()?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return None;
    }

    let mut callback = ParsedCallback {
        code: None,
        state: None,
        provider_error: None,
    };
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = hq_desktop_core::oauth::urldecode(value);
        match name {
            "code" => callback.code = Some(value),
            "state" => callback.state = Some(value),
            "error" => callback.provider_error = Some(value),
            _ => {}
        }
    }
    Some(callback)
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Cache-Control: no-store\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n\
         {body}",
        body.len()
    );
    let _ = stream.set_nonblocking(false);
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(Shutdown::Both);
}

const SUCCESS_HTML: &str = r#"<!doctype html><meta charset="utf-8"><title>Signed in — HQ</title><style>html{color-scheme:light dark}body{font:15px -apple-system;margin:15vh auto;max-width:32rem;text-align:center;padding:2rem}h1{font-size:1.35rem}</style><h1>You are signed in</h1><p>You can close this tab and return to HQ.</p>"#;
const ERROR_HTML: &str = r#"<!doctype html><meta charset="utf-8"><title>Sign-in error — HQ</title><style>html{color-scheme:light dark}body{font:15px -apple-system;margin:15vh auto;max-width:32rem;text-align:center;padding:2rem}h1{font-size:1.35rem}</style><h1>Sign-in could not be completed</h1><p>Return to HQ and try again.</p>"#;
const NOT_FOUND_HTML: &str =
    r#"<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>"#;

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

static PRODUCTION_CONTROLLER: OnceLock<Result<OAuthController, EngineError>> = OnceLock::new();

fn production_controller() -> Result<&'static OAuthController, EngineError> {
    match PRODUCTION_CONTROLLER.get_or_init(OAuthController::production) {
        Ok(controller) => Ok(controller),
        Err(error) => Err(error.clone()),
    }
}

#[derive(Deserialize)]
struct StartParams {
    provider: String,
}

#[derive(Deserialize)]
struct ListenParams {
    state: String,
}

#[derive(Default, Deserialize)]
struct CancelParams {
    state: Option<String>,
}

#[derive(Deserialize)]
struct ExchangeParams {
    code: String,
}

fn decode_params<T: for<'de> Deserialize<'de>>(
    method: &str,
    params: &Value,
) -> Result<T, EngineError> {
    serde_json::from_value(params.clone()).map_err(|error| {
        EngineError::new(
            "invalid_params",
            format!("{method} params are invalid: {error}"),
            false,
        )
    })
}

pub(crate) fn execute(
    _backend: &CoreBackend,
    method: &str,
    params: &Value,
    cancellation: &CancellationFlag,
) -> Result<Value, EngineError> {
    let controller = production_controller()?;
    match method {
        "start_oauth_login" => {
            let params: StartParams = decode_params(method, params)?;
            to_value(controller.start(&params.provider, cancellation)?)
        }
        "oauth_listen_for_code" => {
            let params: ListenParams = decode_params(method, params)?;
            to_value(controller.listen(&params.state, cancellation)?)
        }
        "oauth_cancel_listen" => {
            let params = if params.is_null() {
                CancelParams::default()
            } else {
                decode_params::<CancelParams>(method, params)?
            };
            controller.cancel(params.state.as_deref())?;
            Ok(Value::Null)
        }
        "oauth_exchange_code" => {
            let params: ExchangeParams = decode_params(method, params)?;
            to_value(controller.exchange(&params.code, cancellation)?)
        }
        _ => Err(EngineError::new(
            "method_not_found",
            format!("OAuth method `{method}` is not implemented"),
            false,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    #[derive(Default)]
    struct RecordingTransport {
        calls: Mutex<Vec<(String, BTreeMap<String, String>)>>,
        response: Mutex<Option<Result<FormResponse, EngineError>>>,
        call_count: AtomicUsize,
    }

    impl FormTransport for RecordingTransport {
        fn post_form(
            &self,
            url: &str,
            form: &BTreeMap<String, String>,
            cancellation: &CancellationFlag,
        ) -> Result<FormResponse, EngineError> {
            cancellation.check()?;
            self.call_count.fetch_add(1, Ordering::SeqCst);
            self.calls
                .lock()
                .unwrap()
                .push((url.to_string(), form.clone()));
            self.response.lock().unwrap().take().unwrap()
        }
    }

    #[derive(Default)]
    struct RecordingTokenStore {
        saved: Mutex<Vec<hq_desktop_core::cognito::CognitoTokens>>,
        active: Mutex<Option<hq_desktop_core::cognito::CognitoTokens>>,
        cancel_on_persist: Mutex<Option<CancellationFlag>>,
    }

    impl TokenStore for RecordingTokenStore {
        fn snapshot(&self) -> Result<Option<hq_desktop_core::cognito::CognitoTokens>, EngineError> {
            Ok(self.active.lock().unwrap().clone())
        }

        fn persist(
            &self,
            tokens: &hq_desktop_core::cognito::CognitoTokens,
        ) -> Result<(), EngineError> {
            self.saved.lock().unwrap().push(tokens.clone());
            *self.active.lock().unwrap() = Some(tokens.clone());
            if let Some(cancellation) = self.cancel_on_persist.lock().unwrap().take() {
                cancellation.cancel();
            }
            Ok(())
        }

        fn rollback(
            &self,
            previous: Option<&hq_desktop_core::cognito::CognitoTokens>,
        ) -> Result<(), EngineError> {
            *self.active.lock().unwrap() = previous.cloned();
            Ok(())
        }
    }

    fn available_port() -> u16 {
        TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn test_controller(
        port: u16,
        transport: Arc<RecordingTransport>,
        store: Arc<RecordingTokenStore>,
    ) -> OAuthController {
        OAuthController::new(
            OAuthConfig::for_tests(port, Duration::from_secs(2)),
            transport,
            store,
        )
    }

    #[test]
    fn listener_is_bound_before_start_returns_and_accepts_a_callback() {
        let port = available_port();
        let controller = test_controller(
            port,
            Arc::new(RecordingTransport::default()),
            Arc::new(RecordingTokenStore::default()),
        );
        let cancellation = CancellationFlag::default();
        let started = controller.start("Google", &cancellation).unwrap();

        let mut callback = TcpStream::connect(("127.0.0.1", port))
            .expect("start must not return before loopback is ready");
        write!(
            callback,
            "GET /callback?code=ready-code&state={} HTTP/1.1\r\nHost: localhost\r\n\r\n",
            started.state
        )
        .unwrap();
        let mut response = String::new();
        callback.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));

        let result = controller.listen(&started.state, &cancellation).unwrap();
        assert_eq!(result.code, "ready-code");
    }

    #[test]
    fn callback_state_mismatch_is_rejected_as_csrf() {
        let port = available_port();
        let controller = test_controller(
            port,
            Arc::new(RecordingTransport::default()),
            Arc::new(RecordingTokenStore::default()),
        );
        let cancellation = CancellationFlag::default();
        let started = controller.start("Google", &cancellation).unwrap();

        let mut callback = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            callback,
            "GET /callback?code=injected&state=wrong HTTP/1.1\r\nHost: localhost\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        callback.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 400 Bad Request"));

        let error = controller
            .listen(&started.state, &cancellation)
            .unwrap_err();
        assert_eq!(error.code, "oauth_state_mismatch");
        assert!(!error.message.contains("wrong"));
        assert!(!error.message.contains(&started.state));
    }

    #[test]
    fn cancellation_joins_listener_and_releases_the_socket() {
        let port = available_port();
        let controller = test_controller(
            port,
            Arc::new(RecordingTransport::default()),
            Arc::new(RecordingTokenStore::default()),
        );
        let cancellation = CancellationFlag::default();
        let started = controller.start("Microsoft", &cancellation).unwrap();

        controller.cancel(Some(&started.state)).unwrap();

        TcpListener::bind(("127.0.0.1", port))
            .expect("cancel must synchronously release the callback socket");
        let error = controller
            .listen(&started.state, &cancellation)
            .unwrap_err();
        assert_eq!(error.code, "oauth_not_started");
    }

    #[test]
    fn exchange_posts_exact_pkce_form_and_persists_tokens() {
        let port = available_port();
        let transport = Arc::new(RecordingTransport::default());
        *transport.response.lock().unwrap() = Some(Ok(FormResponse {
            status: 200,
            body: json!({
                "access_token": "access-secret",
                "id_token": "id-secret",
                "refresh_token": "refresh-secret",
                "expires_in": 3600
            }),
        }));
        let store = Arc::new(RecordingTokenStore::default());
        let controller = test_controller(port, transport.clone(), store.clone());
        let cancellation = CancellationFlag::default();
        let started = controller.start("Google", &cancellation).unwrap();
        controller.cancel(Some(&started.state)).unwrap();
        controller.install_verifier_for_test("one-shot-verifier");

        let state = controller
            .exchange("authorization-code", &cancellation)
            .unwrap();

        assert!(state.authenticated);
        assert!(state.expires_at.is_some());
        let calls = transport.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, hq_desktop_core::oauth::cognito_token_url());
        assert_eq!(
            calls[0].1,
            BTreeMap::from([
                (
                    "client_id".into(),
                    hq_desktop_core::oauth::COGNITO_CLIENT_ID.into()
                ),
                ("code".into(), "authorization-code".into()),
                ("code_verifier".into(), "one-shot-verifier".into()),
                ("grant_type".into(), "authorization_code".into()),
                (
                    "redirect_uri".into(),
                    hq_desktop_core::oauth::REDIRECT_URI.into()
                ),
            ])
        );
        let saved = store.saved.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].access_token, "access-secret");
        assert_eq!(saved[0].refresh_token, "refresh-secret");
    }

    #[test]
    fn cancelled_exchange_clears_tokens_persisted_during_cancellation() {
        let transport = Arc::new(RecordingTransport::default());
        *transport.response.lock().unwrap() = Some(Ok(FormResponse {
            status: 200,
            body: json!({
                "access_token": "cancelled-access",
                "id_token": "cancelled-id",
                "refresh_token": "cancelled-refresh",
                "expires_in": 60
            }),
        }));
        let store = Arc::new(RecordingTokenStore::default());
        let cancellation = CancellationFlag::default();
        *store.cancel_on_persist.lock().unwrap() = Some(cancellation.clone());
        let controller =
            test_controller(available_port(), Arc::clone(&transport), Arc::clone(&store));
        controller.install_verifier_for_test("cancelled-verifier");

        let error = controller
            .exchange("cancelled-code", &cancellation)
            .unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        assert!(
            store.active.lock().unwrap().is_none(),
            "a cancelled exchange must not leave its new credentials active"
        );
    }

    #[test]
    fn cancelled_exchange_restores_credentials_that_preceded_the_attempt() {
        let transport = Arc::new(RecordingTransport::default());
        *transport.response.lock().unwrap() = Some(Ok(FormResponse {
            status: 200,
            body: json!({
                "access_token": "cancelled-access",
                "id_token": "cancelled-id",
                "refresh_token": "cancelled-refresh",
                "expires_in": 60
            }),
        }));
        let store = Arc::new(RecordingTokenStore::default());
        let previous = hq_desktop_core::cognito::CognitoTokens {
            access_token: "previous-access".to_string(),
            id_token: Some("previous-id".to_string()),
            refresh_token: "previous-refresh".to_string(),
            expires_at: i64::MAX,
        };
        *store.active.lock().unwrap() = Some(previous.clone());
        let cancellation = CancellationFlag::default();
        *store.cancel_on_persist.lock().unwrap() = Some(cancellation.clone());
        let controller =
            test_controller(available_port(), Arc::clone(&transport), Arc::clone(&store));
        controller.install_verifier_for_test("cancelled-verifier");

        let error = controller
            .exchange("cancelled-code", &cancellation)
            .unwrap_err();

        assert_eq!(error.code, "request_cancelled");
        let active = store.active.lock().unwrap();
        let active = active
            .as_ref()
            .expect("the prior credentials must be restored");
        assert_eq!(active.access_token, previous.access_token);
        assert_eq!(active.refresh_token, previous.refresh_token);
    }

    #[test]
    fn successful_callback_preserves_the_one_shot_verifier_for_exchange() {
        let port = available_port();
        let transport = Arc::new(RecordingTransport::default());
        *transport.response.lock().unwrap() = Some(Ok(FormResponse {
            status: 200,
            body: json!({
                "access_token": "access-secret",
                "refresh_token": "refresh-secret",
                "expires_in": 60
            }),
        }));
        let store = Arc::new(RecordingTokenStore::default());
        let controller = test_controller(port, transport.clone(), store.clone());
        let cancellation = CancellationFlag::default();
        let started = controller.start("Google", &cancellation).unwrap();

        let mut callback = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            callback,
            "GET /callback?code=ready-code&state={} HTTP/1.1\r\nHost: localhost\r\n\r\n",
            started.state
        )
        .unwrap();
        callback.shutdown(std::net::Shutdown::Write).unwrap();
        controller.listen(&started.state, &cancellation).unwrap();

        let auth = controller.exchange("ready-code", &cancellation).unwrap();
        assert!(auth.authenticated);
        assert_eq!(transport.call_count.load(Ordering::SeqCst), 1);
        assert_eq!(store.saved.lock().unwrap().len(), 1);
        let second = controller
            .exchange("ready-code", &cancellation)
            .unwrap_err();
        assert_eq!(second.code, "oauth_not_started");
        assert_eq!(transport.call_count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn exchange_without_a_verifier_never_touches_the_network() {
        let transport = Arc::new(RecordingTransport::default());
        let controller = test_controller(
            available_port(),
            transport.clone(),
            Arc::new(RecordingTokenStore::default()),
        );

        let error = controller
            .exchange("authorization-code", &CancellationFlag::default())
            .unwrap_err();

        assert_eq!(error.code, "oauth_not_started");
        assert_eq!(transport.call_count.load(Ordering::SeqCst), 0);
    }
}
