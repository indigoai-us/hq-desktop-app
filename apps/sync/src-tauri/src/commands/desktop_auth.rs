//! Browser session continuation — the native half.
//!
//! Someone signs up on hqforwork.com, downloads HQ, opens it, and is asked to
//! sign in to the account they created four minutes ago. Between 2026-08-31 and
//! 2026-09-08, 101 people finished signup and were linked to a person, 43 ever
//! opened the desktop app, and of the 103 who reached the sign-in step only 66
//! got through. Three of those were recorded as an OAuth failure. The rest just
//! stopped.
//!
//! This module finishes that sign-in instead of asking for it again. It opens
//! the system browser through the ordinary Cognito authorization-code flow with
//! PKCE — the same flow the provider buttons use, the same app client, the same
//! loopback callback — and then does one thing differently: it holds the
//! resulting tokens in memory, asks the backend to verify them, shows the person
//! **Continue as \<email\>**, and only writes anything once they say yes.
//!
//! ## What this module deliberately is not
//!
//! It is not a handoff token attached to the download link. A signed assertion
//! travelling in a URL proves who *issued* it, not who *holds* it, and download
//! links get forwarded — to a colleague, into a group chat, through a helpdesk
//! ticket. That design was considered and rejected as an account-takeover
//! capability. Nothing here introduces a new signing key, and if a future change
//! seems to need one, it has drifted back into the rejected design.
//!
//! ## The rules the code is arranged around
//!
//! * **Off unless switched on.** A missing config, an unreachable backend, an
//!   unparseable body, or a protocol version this build does not implement all
//!   mean disabled, and disabled means the existing provider buttons — exactly
//!   what ships today.
//! * **Nothing is written before confirmation.** Tokens live in
//!   [`ContinuationCustody`], which has no serialize, no clone, and a `Debug`
//!   that prints a placeholder.
//! * **The renderer never sees a credential.** `confirm` and `cancel` take an
//!   attempt id. The only thing that crosses the bridge is an email and a
//!   display name, so the confirmation can say whose account it is.
//! * **One attempt at a time.** A second start supersedes the first rather than
//!   racing it, which is what makes two callbacks arriving together an answered
//!   question.
//!
//! The decision logic lives in `hq_desktop_core::session_continuation` and
//! `hq_desktop_core::continuation_custody`, which are pure and unit-tested. This
//! file is the wiring: Tauri commands, HTTP, and the browser. Keeping it thin is
//! not tidiness — `src-tauri` cannot be compiled without a GTK/JavaScriptCore
//! toolchain, so logic placed here is logic that no unit test can reach.

use hq_desktop_core::authenticated_receipts::{
    classify_receipt_http_status, may_deliver_for_account, next_receipt_attempt_count,
    next_receipt_retry_at_ms, ReceiptHttpDisposition,
};
use hq_desktop_core::continuation_custody::{
    ContinuationCustody, CustodyError, PendingCredentials, VerifiedIdentity,
};
use hq_desktop_core::continuation_endpoints::ContinuationEndpoints;
use hq_desktop_core::first_run::LaunchKind;
use hq_desktop_core::session_continuation::{
    may_start, AttemptEnd, ContinuationAttempt, LaunchContext, RolloutDecision, StartRefusal,
};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

use crate::util::client_info::build_client;

use super::cognito::{self, AuthState, CognitoTokens};

/// Process-wide custody. One machine, one pending sign-in.
///
/// A plain `std::sync::Mutex` and never held across an `.await`: every guard in
/// this file is taken, used, and dropped inside one block. Holding it across an
/// HTTP round trip would let a slow provider block a Cancel click.
static CUSTODY: Mutex<Option<ContinuationCustody>> = Mutex::new(None);

/// Serializes authenticated receipt drains so one background retry cannot race
/// another. File mutations use a separate short-lived lock and never span HTTP.
static AUTHENTICATED_RECEIPT_FLUSH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static AUTHENTICATED_RECEIPT_QUEUE_IO: Mutex<()> = Mutex::new(());
/// Receipts enter in-memory custody synchronously, then a dedicated blocking
/// worker performs the lock/read/fsync/rename sequence. This keeps authentication
/// and workspace commands off the filesystem while retaining each receipt until
/// its durable append succeeds.
static AUTHENTICATED_RECEIPT_CUSTODY: Mutex<Vec<AuthenticatedDesktopReceipt>> =
    Mutex::new(Vec::new());

fn with_custody<T>(f: impl FnOnce(&mut ContinuationCustody) -> T) -> T {
    let mut guard = CUSTODY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(guard.get_or_insert_with(ContinuationCustody::new))
}

/// Bump the account generation and discard anything pending.
///
/// Called by sign-out and by a manual sign-in completing. An attempt that was
/// waiting for confirmation when the account changed underneath it is now about
/// a question nobody asked, and its tokens go unwritten.
pub(crate) fn note_auth_transition(end: AttemptEnd) {
    if end == AttemptEnd::SignedOut {
        // Latched for the life of the process. Signing someone back in
        // moments after they deliberately signed out is the single most
        // hostile thing this feature could do, and the rollout being on is not
        // a reason to do it. It does not need to survive a restart: a restart
        // is not a first launch, and `may_start` refuses on that ground too.
        SIGNED_OUT_THIS_SESSION.store(true, Ordering::SeqCst);
    }
    with_custody(|custody| custody.bump_generation(end));
}

/// Set when the person signs out on purpose. Never cleared.
static SIGNED_OUT_THIS_SESSION: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// What the renderer is told about a refusal.
///
/// A closed vocabulary. Deliberately coarse: the renderer's only real decision
/// is "show the provider buttons", and a more precise reason would be a more
/// precise thing to leak.
fn custody_error_code(error: CustodyError) -> &'static str {
    match error {
        CustodyError::NoSuchAttempt => "CONTINUATION_NO_ATTEMPT",
        CustodyError::Finished(_) => "CONTINUATION_ATTEMPT_OVER",
        CustodyError::StateMismatch => "CONTINUATION_STATE_MISMATCH",
        CustodyError::NonceMismatch => "CONTINUATION_TOKEN_MISMATCH",
        CustodyError::NothingHeld => "CONTINUATION_NOTHING_HELD",
    }
}

/// What the renderer is told when the machine's own state forbids a start.
///
/// Same closed-vocabulary rule as [`custody_error_code`]. The renderer maps all
/// of these to "show the provider buttons" — the screen that ships today — so
/// the distinction exists for the operational counters, not for the UI.
fn start_refusal_code(refusal: StartRefusal) -> &'static str {
    match refusal {
        StartRefusal::AlreadySignedIn => "CONTINUATION_REFUSED_SIGNED_IN",
        StartRefusal::ExplicitlySignedOut => "CONTINUATION_REFUSED_SIGNED_OUT",
        StartRefusal::AttemptInFlight => "CONTINUATION_REFUSED_IN_FLIGHT",
        StartRefusal::UpdateInProgress => "CONTINUATION_REFUSED_UPDATING",
        StartRefusal::NotAFirstLaunch => "CONTINUATION_REFUSED_NOT_FIRST_LAUNCH",
    }
}

/// What this machine knows about itself right now.
///
/// Assembled natively because not one of these five facts is visible to the
/// renderer. The rollout half of the decision was already made upstream by
/// `desktop-session-continuation.ts`, which is why [`RolloutDecision::Continue`]
/// is passed here: this call adds the machine-state half, and a caller that
/// skipped the rollout gate still cannot get past these.
async fn launch_context(app: &AppHandle) -> LaunchContext {
    let has_valid_session = super::auth::get_auth_state(app.clone())
        .await
        .map(|state| state.authenticated)
        // A session we cannot evaluate is not a session we may talk over.
        .unwrap_or(true);

    let attempt_in_flight = super::oauth::oauth_flow_keeps_window_visible()
        || with_custody(|custody| {
            custody.tick(now_ms());
            custody.active_attempt_id().is_some()
        });

    let is_first_launch = app
        .try_state::<super::first_run::LaunchKindState>()
        .map(|state| state.0 == LaunchKind::FirstRun)
        // `classify_launch` runs at the top of `.setup()`. If the verdict is
        // missing, something is wrong with startup ordering and the safe read
        // is "not a first launch", which refuses.
        .unwrap_or(false);

    LaunchContext {
        has_valid_session,
        signed_out_explicitly: SIGNED_OUT_THIS_SESSION.load(Ordering::SeqCst),
        attempt_in_flight,
        update_in_progress: crate::updater::update_install_in_progress(),
        is_first_launch,
    }
}

// ── Configuration ──────────────────────────────────────────────────────

/// What the renderer needs to decide whether continuation runs.
///
/// Note what this does NOT do: it does not fetch the rollout document, parse
/// it, or decide anything. Those all live in the renderer's
/// `desktop-session-continuation.ts`, which has real unit tests, because
/// `src-tauri` cannot be compiled on a machine without a GTK/JavaScriptCore
/// toolchain and a rollout decision nobody can test is a rollout decision
/// nobody should trust. This command supplies only the three facts the
/// renderer cannot know on its own.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationContext {
    /// Stable per-installation id. The join key to the website's signup funnel,
    /// and the input to the rollout bucket — which is why it must not change
    /// between launches.
    pub install_attempt_id: String,
    pub app_version: String,
    /// Vault API base, resolved the same way the sync path resolves it, so a
    /// dev install pointed elsewhere by `HQ_VAULT_API_URL` stays pointed there.
    pub api_base: String,
}

fn endpoints() -> ContinuationEndpoints {
    match super::sync::resolve_vault_api_url() {
        Ok(base) => ContinuationEndpoints::with_api_base(base),
        // A config read that fails is not a reason to guess. The resolver's own
        // default is the canonical URL, which is where an unconfigured install
        // would have gone anyway.
        Err(_) => ContinuationEndpoints::resolve(),
    }
}

/// The facts continuation needs before it can decide anything.
///
/// Returns `None` when there is no resolvable home directory, so there is no
/// stable installation id. Inventing one would put the same machine on a
/// different side of the rollout line every launch — the experiment would be
/// unreadable and the same person could see two different sign-in screens on
/// consecutive days. The renderer reads `None` as "off", which is the screen
/// that ships today.
#[tauri::command]
pub fn desktop_continuation_context(app: AppHandle) -> Option<ContinuationContext> {
    Some(ContinuationContext {
        install_attempt_id: super::first_run::install_attempt_id()?,
        app_version: app.package_info().version.to_string(),
        api_base: endpoints().api_base,
    })
}

// ── The attempt ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationStarted {
    pub attempt_id: String,
}

/// May this machine start an attempt? `None` is yes; `Some` is the refusal.
///
/// Asked by the renderer before it writes a `started` receipt, because none of
/// these five refusals is an outcome of an attempt — they are facts about the
/// installation, and reporting them as failures would drown the funnel this
/// work exists to repair. `desktop_continuation_start` checks the same thing
/// again; a caller that skips this one gets an error instead of a browser.
#[tauri::command]
pub async fn desktop_continuation_may_start(app: AppHandle) -> Option<String> {
    may_start(launch_context(&app).await, RolloutDecision::Continue)
        .err()
        .map(|refusal| start_refusal_code(refusal).to_string())
}

/// Begin an attempt: arm the loopback listener and open the system browser.
///
/// Returns as soon as the browser is open. Waiting for the callback is a
/// separate command so a Cancel click is never queued behind a person who
/// wandered off mid-login.
#[tauri::command]
pub async fn desktop_continuation_start(app: AppHandle) -> Result<ContinuationStarted, String> {
    // Before anything opens: is this machine even eligible? An enrolled
    // installation that has a session, that just signed out, that is mid-update,
    // that already has a login in flight, or that is simply not on its first
    // launch must not have a browser thrown at it.
    may_start(launch_context(&app).await, RolloutDecision::Continue)
        .map_err(|refusal| start_refusal_code(refusal).to_string())?;

    let attempt_id = uuid::Uuid::new_v4().to_string();
    let nonce = hq_desktop_core::oauth::generate_nonce();

    // No identity provider: continuation lets the hosted UI use whichever
    // session the browser already has, which is the entire point — the person
    // signed in there minutes ago.
    let armed = super::oauth::arm_oauth_flow(&app, None, Some(&nonce))?;

    with_custody(|custody| {
        let attempt = ContinuationAttempt::start(
            attempt_id.clone(),
            armed.state.clone(),
            nonce.clone(),
            custody.generation(),
            now_ms(),
        );
        custody.begin(attempt);
    });

    if let Err(error) = app.shell().open(armed.authorize_url.as_str(), None) {
        with_custody(|custody| custody.cancel(&attempt_id, AttemptEnd::Failed));
        // The listener was armed before the browser was opened, so a failure
        // here leaves it holding both loopback sockets and the blur-suppression
        // flag with nothing ever coming back.
        release_listener(&armed.state);
        return Err(format!("Could not open the browser: {error}"));
    }

    Ok(ContinuationStarted { attempt_id })
}

/// Wait for the callback, exchange the code, verify server-side, and hold.
///
/// Resolves with the identity to put in front of the person. Nothing has been
/// written to disk when this returns.
#[tauri::command]
pub async fn desktop_continuation_await_identity(
    app: AppHandle,
    attempt_id: String,
) -> Result<VerifiedIdentityPayload, String> {
    // Refuse before waiting, so a stale attempt id does not park a task on a
    // listener that belongs to somebody else's attempt.
    let active = with_custody(|custody| {
        custody.tick(now_ms());
        custody.active_attempt_id().map(str::to_string)
    });
    if active.as_deref() != Some(attempt_id.as_str()) {
        return Err(custody_error_code(CustodyError::NoSuchAttempt).to_string());
    }

    // The listener validates the state itself before handing back a code and
    // returns the value it matched. Custody checks it again against the
    // attempt: the two stores can only disagree if something went wrong, and
    // that is exactly when a second check earns its keep.
    let (callback, matched_state) = super::oauth::oauth_listen_for_code_internal(&app).await?;
    with_custody(|custody| custody.accept_callback(&attempt_id, &matched_state, now_ms()))
        .map_err(|error| custody_error_code(error).to_string())?;

    let tokens = super::oauth::exchange_code_for_tokens(&callback.code).await?;

    // Server-side verification. The desktop reading its own claims proves
    // nothing — the backend checks the signature, the audience, and that the
    // subject is a person this deployment knows.
    let identity = verify_with_backend(&tokens).await?;

    let nonce = cognito::decode_id_token_claims(tokens.id_token.as_deref().unwrap_or_default())
        .ok()
        .and_then(|claims| claims.nonce);

    let held = with_custody(|custody| {
        custody.hold(
            &attempt_id,
            nonce.as_deref(),
            PendingCredentials::new(tokens, identity),
            now_ms(),
        )
    })
    .map_err(|error| custody_error_code(error).to_string())?;

    Ok(VerifiedIdentityPayload::from(held))
}

/// The identity a confirmation prompt shows. Nothing replayable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedIdentityPayload {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl From<VerifiedIdentity> for VerifiedIdentityPayload {
    fn from(identity: VerifiedIdentity) -> Self {
        Self {
            email: identity.email,
            display_name: identity.display_name,
        }
    }
}

/// The person pressed **Continue as …**. Persist and sign in.
#[tauri::command]
pub async fn desktop_continuation_confirm(
    app: AppHandle,
    attempt_id: String,
) -> Result<AuthState, String> {
    let credentials = with_custody(|custody| custody.confirm(&attempt_id, now_ms()))
        .map_err(|error| custody_error_code(error).to_string())?;

    // Only now does anything touch the disk. `complete_auth_session` is the
    // same completion the provider-button path runs, so both flows end in one
    // definition of "signed in".
    let tokens: CognitoTokens = credentials.into_tokens();
    let state = super::auth::complete_auth_session(&app, &tokens).await?;

    // This is the first durable, human-authenticated edge in the browser
    // continuation flow. It enters process custody before the background
    // durable writer runs, so quitting after a completed write preserves its
    // original event id and timestamp for a later retry.
    if let Some(account_id) = state.account_id.as_deref() {
        record_desktop_login_completed(&app, account_id, "browser_continuation", "continuation");
    } else {
        eprintln!("[desktop-onboarding] login_completed receipt not queued without an authenticated account");
    }

    // The account just changed. Anything still pending is about a question
    // nobody asked any more.
    note_auth_transition(AttemptEnd::Superseded);
    Ok(state)
}

/// **Use another account**, Cancel, or the window going away.
///
/// Idempotent, because the renderer legitimately sends it twice: once from the
/// click and once from component teardown.
#[tauri::command]
pub async fn desktop_continuation_cancel(attempt_id: String) -> Result<(), String> {
    // Read the state before cancelling — cancelling finishes the attempt, and a
    // finished attempt has no state to hand over. Scoped to this attempt id so
    // a late Cancel for a superseded attempt cannot tear down the listener the
    // current one is waiting on.
    let state = with_custody(|custody| custody.active_state_for(&attempt_id).map(str::to_string));
    with_custody(|custody| custody.cancel(&attempt_id, AttemptEnd::Cancelled));

    // Dropping the custody entry is not cancelling. Without this the listener
    // thread keeps both loopback sockets and `OAUTH_FLOW_ACTIVE` alive until a
    // callback or the five-minute timeout, so blur-hide stays suppressed and
    // Cancel visibly cancels nothing.
    if let Some(state) = state {
        release_listener(&state);
    }
    Ok(())
}

/// Cancel the loopback listener armed for `state`, clearing its PKCE verifier.
///
/// Failures are swallowed on purpose: this is teardown on a path the person has
/// already left, and the listener's own timeout is the backstop.
fn release_listener(state: &str) {
    if let Err(error) = super::oauth::oauth_cancel_listen(Some(state.to_string())) {
        eprintln!("[continuation] listener teardown failed: {error}");
    }
}

// ── Authenticated desktop funnel receipts ──────────────────────────────

/// The authenticated onboarding routes deliberately live in the native shell:
/// the renderer never receives a bearer token. Both receipts use the durable
/// installation id used by the anonymous first-launch receipt, which is what
/// lets raw telemetry join an installer to a later authenticated action.
const AUTHENTICATED_RECEIPT_QUEUE_VERSION: u8 = 1;
const AUTHENTICATED_RECEIPT_QUEUE_FILE: &str = "desktop-onboarding-receipts.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum AuthenticatedReceiptEndpoint {
    SessionActivated,
    WorkspaceSelected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedDesktopReceipt {
    endpoint: AuthenticatedReceiptEndpoint,
    body: serde_json::Value,
    /// Cognito subject of the account that authorized this receipt. Older rows
    /// deserialize as unbound and are retained rather than sent as a new user.
    #[serde(default)]
    authorized_account_id: Option<String>,
    #[serde(default)]
    attempts: u8,
    #[serde(default)]
    next_attempt_at_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthenticatedReceiptQueue {
    version: u8,
    receipts: Vec<AuthenticatedDesktopReceipt>,
}

fn authenticated_receipt_queue_path_from_home(home: &Path) -> PathBuf {
    home.join(".hq").join(AUTHENTICATED_RECEIPT_QUEUE_FILE)
}

fn authenticated_receipt_queue_path() -> Option<PathBuf> {
    crate::util::paths::home_dir().map(|home| authenticated_receipt_queue_path_from_home(&home))
}

fn read_authenticated_receipt_queue(
    path: &Path,
) -> Result<Vec<AuthenticatedDesktopReceipt>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let body =
        fs::read_to_string(path).map_err(|error| format!("read desktop receipt queue: {error}"))?;
    let queue: AuthenticatedReceiptQueue = serde_json::from_str(&body)
        .map_err(|error| format!("parse desktop receipt queue: {error}"))?;
    if queue.version != AUTHENTICATED_RECEIPT_QUEUE_VERSION {
        return Err(format!(
            "unsupported desktop receipt queue version: {}",
            queue.version
        ));
    }
    Ok(queue.receipts)
}

fn write_authenticated_receipt_queue(
    path: &Path,
    receipts: &[AuthenticatedDesktopReceipt],
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "desktop receipt queue has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create desktop receipt queue dir: {error}"))?;
    let queue = AuthenticatedReceiptQueue {
        version: AUTHENTICATED_RECEIPT_QUEUE_VERSION,
        receipts: receipts.to_vec(),
    };
    let body = serde_json::to_vec(&queue)
        .map_err(|error| format!("serialize desktop receipt queue: {error}"))?;
    let temporary = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("create desktop receipt queue temp file: {error}"))?;
    file.write_all(&body)
        .map_err(|error| format!("write desktop receipt queue temp file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync desktop receipt queue temp file: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("commit desktop receipt queue: {error}"))
}

/// Persist a receipt before scheduling any network work. The event id and
/// occurredAt in `receipt.body` are never re-minted by a retry.
fn enqueue_authenticated_desktop_receipts(
    pending: Vec<AuthenticatedDesktopReceipt>,
) -> Result<(), String> {
    if pending.is_empty() {
        return Ok(());
    }
    let path = authenticated_receipt_queue_path()
        .ok_or_else(|| "desktop receipt queue home is unavailable".to_string())?;
    let _queue_guard = AUTHENTICATED_RECEIPT_QUEUE_IO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut receipts = read_authenticated_receipt_queue(&path)?;
    receipts.extend(pending);
    write_authenticated_receipt_queue(&path, &receipts)
}

/// Take receipts from process custody and write them on Tauri's blocking pool.
/// A failed or interrupted write restores the complete batch; a duplicate after
/// an ambiguous write is safe because the server event id is stable.
async fn persist_authenticated_receipt_custody() {
    let pending = {
        let mut custody = AUTHENTICATED_RECEIPT_CUSTODY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::take(&mut *custody)
    };
    if pending.is_empty() {
        return;
    }
    let restore = pending.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        enqueue_authenticated_desktop_receipts(pending)
    })
    .await
    .map_err(|error| format!("desktop receipt persistence task failed: {error}"))
    .and_then(|result| result);
    if let Err(error) = result {
        eprintln!("[desktop-onboarding] receipt queue persistence failed: {error}");
        let mut custody = AUTHENTICATED_RECEIPT_CUSTODY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        custody.splice(0..0, restore);
        return;
    }
    flush_pending_authenticated_desktop_receipts();
}

/// Accept a receipt immediately and schedule its durable write without making
/// an auth or workspace command wait for filesystem I/O.
fn schedule_authenticated_desktop_receipt(receipt: AuthenticatedDesktopReceipt) {
    {
        let mut custody = AUTHENTICATED_RECEIPT_CUSTODY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        custody.push(receipt);
    }
    tauri::async_runtime::spawn(async { persist_authenticated_receipt_custody().await });
}

fn without_terminal_receipts(
    current: Vec<AuthenticatedDesktopReceipt>,
    terminal: &[AuthenticatedDesktopReceipt],
) -> Vec<AuthenticatedDesktopReceipt> {
    current
        .into_iter()
        .filter(|receipt| !terminal.contains(receipt))
        .collect()
}

enum AuthenticatedReceiptDelivery {
    Delivered,
    Retry,
    Rejected,
    HeldForAuthorizedAccount,
}

async fn current_authenticated_account_id() -> Result<Option<String>, String> {
    cognito::get_tokens()
        .await
        .map(|tokens| tokens.map(|tokens| super::auth::notification_identity_from_tokens(&tokens)))
}

async fn post_authenticated_desktop_receipt(
    receipt: &AuthenticatedDesktopReceipt,
    active_account_id: Option<&str>,
) -> Result<AuthenticatedReceiptDelivery, String> {
    if !may_deliver_for_account(receipt.authorized_account_id.as_deref(), active_account_id) {
        return Ok(AuthenticatedReceiptDelivery::HeldForAuthorizedAccount);
    }
    let url = match receipt.endpoint {
        AuthenticatedReceiptEndpoint::SessionActivated => endpoints().session_activated_url(),
        AuthenticatedReceiptEndpoint::WorkspaceSelected => endpoints().workspace_selected_url(),
    };
    let jwt = super::sync::resolve_jwt().await?;
    let response = build_client()
        .post(url)
        .bearer_auth(jwt)
        .json(&receipt.body)
        .send()
        .await
        .map_err(|error| format!("desktop telemetry request failed: {error}"))?;
    let status = response.status().as_u16();
    match classify_receipt_http_status(status) {
        ReceiptHttpDisposition::Delivered => Ok(AuthenticatedReceiptDelivery::Delivered),
        ReceiptHttpDisposition::Retry => Ok(AuthenticatedReceiptDelivery::Retry),
        ReceiptHttpDisposition::Rejected => {
            eprintln!("[desktop-onboarding] rejecting receipt after permanent HTTP {status}");
            Ok(AuthenticatedReceiptDelivery::Rejected)
        }
    }
}

/// Drain persisted receipts oldest-first. Runs only after authentication, so
/// no bearer credential ever lands in the on-disk queue.
async fn flush_authenticated_desktop_receipts() -> Result<(), String> {
    let _flush_guard = AUTHENTICATED_RECEIPT_FLUSH.lock().await;
    let path = match authenticated_receipt_queue_path() {
        Some(path) => path,
        None => return Ok(()),
    };
    let queued = {
        let _queue_guard = AUTHENTICATED_RECEIPT_QUEUE_IO
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        read_authenticated_receipt_queue(&path)?
    };
    if queued.is_empty() {
        return Ok(());
    }

    let active_account_id = current_authenticated_account_id().await?;
    let mut terminal = Vec::new();
    let mut retries = Vec::new();
    let now = now_ms();
    for receipt in queued {
        if receipt.next_attempt_at_ms > now {
            continue;
        }
        match post_authenticated_desktop_receipt(&receipt, active_account_id.as_deref()).await {
            Ok(
                AuthenticatedReceiptDelivery::Delivered | AuthenticatedReceiptDelivery::Rejected,
            ) => terminal.push(receipt),
            Ok(AuthenticatedReceiptDelivery::Retry) => {
                let mut retry = receipt.clone();
                retry.next_attempt_at_ms = next_receipt_retry_at_ms(now, retry.attempts);
                retry.attempts = next_receipt_attempt_count(retry.attempts);
                retries.push((receipt, retry));
            }
            Ok(AuthenticatedReceiptDelivery::HeldForAuthorizedAccount) => {
                eprintln!("[desktop-onboarding] receipt held for its authorizing account");
            }
            Err(error) => {
                eprintln!("[desktop-onboarding] receipt delivery will retry: {error}");
                let mut retry = receipt.clone();
                retry.next_attempt_at_ms = next_receipt_retry_at_ms(now, retry.attempts);
                retry.attempts = next_receipt_attempt_count(retry.attempts);
                retries.push((receipt, retry));
            }
        }
    }
    let _queue_guard = AUTHENTICATED_RECEIPT_QUEUE_IO
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut current =
        without_terminal_receipts(read_authenticated_receipt_queue(&path)?, &terminal);
    for (original, retry) in retries {
        if let Some(position) = current.iter().position(|candidate| candidate == &original) {
            current[position] = retry;
        }
    }
    write_authenticated_receipt_queue(&path, &current)
}

/// Schedule a retry after a durable receipt has been written. The same helper
/// is also called when the app restores an authenticated session.
pub(crate) fn flush_pending_authenticated_desktop_receipts() {
    tauri::async_runtime::spawn(async {
        if let Err(error) = flush_authenticated_desktop_receipts().await {
            eprintln!("[desktop-onboarding] receipt queue flush failed: {error}");
        }
    });
}

fn desktop_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else {
        "mac"
    }
}

fn desktop_receipt_base(app: &AppHandle) -> Option<serde_json::Value> {
    let install_attempt_id = super::first_run::install_attempt_id()?;
    Some(serde_json::json!({
        "installAttemptId": install_attempt_id,
        "eventId": uuid::Uuid::new_v4().to_string(),
        "occurredAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "platform": desktop_platform(),
        "version": app.package_info().version.to_string(),
    }))
}

/// Record the successful native sign-in edge. This has no company attribution:
/// a login can complete before a workspace is selected, and pretending one was
/// selected would corrupt the person-to-company join.
pub(crate) fn record_desktop_login_completed(
    app: &AppHandle,
    authorized_account_id: &str,
    flow: &str,
    variant: &str,
) {
    let result = (|| -> Result<(), String> {
        let mut body = desktop_receipt_base(app)
            .ok_or_else(|| "desktop installation id is unavailable".to_string())?;
        let object = body
            .as_object_mut()
            .ok_or_else(|| "desktop telemetry body was not an object".to_string())?;
        object.insert("flow".to_string(), serde_json::json!(flow));
        object.insert("variant".to_string(), serde_json::json!(variant));
        object.insert("provider".to_string(), serde_json::json!("cognito"));
        schedule_authenticated_desktop_receipt(AuthenticatedDesktopReceipt {
            endpoint: AuthenticatedReceiptEndpoint::SessionActivated,
            body,
            authorized_account_id: Some(authorized_account_id.to_string()),
            attempts: 0,
            next_attempt_at_ms: 0,
        });
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[desktop-onboarding] login_completed receipt queue failed: {error}");
        return;
    }
}

/// Record the company the person explicitly connected from the desktop shell.
/// The server resolves the person from the JWT and verifies active membership;
/// the client never gets to assert either identity. A selection can occur long
/// after sign-in, so it intentionally carries no auth cohort fields rather
/// than guessing that it belongs to the manual-control arm.
pub(crate) async fn record_desktop_workspace_selected(app: &AppHandle, company_uid: String) {
    let authorized_account_id = match current_authenticated_account_id().await {
        Ok(Some(account_id)) => account_id,
        Ok(None) => {
            eprintln!("[desktop-onboarding] workspace_selected receipt not queued without an authenticated account");
            return;
        }
        Err(error) => {
            eprintln!("[desktop-onboarding] workspace_selected account lookup failed: {error}");
            return;
        }
    };
    let result = (|| -> Result<(), String> {
        let mut body = desktop_receipt_base(app)
            .ok_or_else(|| "desktop installation id is unavailable".to_string())?;
        let object = body
            .as_object_mut()
            .ok_or_else(|| "desktop telemetry body was not an object".to_string())?;
        object.insert("workspaceKind".to_string(), serde_json::json!("company"));
        object.insert("companyUid".to_string(), serde_json::json!(company_uid));
        // This exact pair is validated by hq-pro's workspace receipt contract.
        object.insert("flow".to_string(), serde_json::json!("workspace_selection"));
        object.insert("variant".to_string(), serde_json::json!("native"));
        schedule_authenticated_desktop_receipt(AuthenticatedDesktopReceipt {
            endpoint: AuthenticatedReceiptEndpoint::WorkspaceSelected,
            body,
            authorized_account_id: Some(authorized_account_id.clone()),
            attempts: 0,
            next_attempt_at_ms: 0,
        });
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("[desktop-onboarding] workspace_selected receipt queue failed: {error}");
        return;
    }
}

// ── Anonymous HTTP, performed natively ─────────────────────────────────
//
// The renderer used to make these two calls itself with the HTTP plugin. That
// worked in the compact popover and silently did not work in the expanded
// desktop window: `capabilities/desktop-alt.json` grants no `http:default`, so
// the request was denied, the rollout resolved to unavailable, and continuation
// could never run on the surface `hq-desktop://signin` opens. The fix is not to
// widen that capability — it is deliberately minimal — but to move the two
// calls here, where they need no webview permission at all and the renderer can
// no longer name a URL.

/// Fetch the rollout document. The renderer still decides what it means.
#[tauri::command]
pub async fn desktop_continuation_config() -> Result<serde_json::Value, String> {
    let response = build_client()
        .get(endpoints().config_url())
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|_| "CONTINUATION_OFFLINE".to_string())?;

    if !response.status().is_success() {
        // Not a config. The renderer reads any error here as disabled, which is
        // the provider buttons — the screen that ships today.
        return Err(format!(
            "CONTINUATION_CONFIG_STATUS_{}",
            response.status().as_u16()
        ));
    }

    response
        .json()
        .await
        .map_err(|_| "CONTINUATION_CONFIG_UNREADABLE".to_string())
}

/// Deliver one anonymous receipt. Returns the HTTP status so the renderer can
/// apply its own recorded / retry / rejected rule, which is where that rule is
/// tested.
///
/// `path` is resolved through [`ContinuationEndpoints::receipt_url`], which
/// accepts exactly the two anonymous onboarding routes. The renderer chooses
/// when a receipt is sent; it does not get to choose where.
#[tauri::command]
pub async fn desktop_continuation_deliver(
    path: String,
    body: serde_json::Value,
) -> Result<u16, String> {
    let url = endpoints()
        .receipt_url(&path)
        .ok_or_else(|| "CONTINUATION_RECEIPT_PATH_REFUSED".to_string())?;

    let response = build_client()
        .post(url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| "CONTINUATION_OFFLINE".to_string())?;

    Ok(response.status().as_u16())
}

// ── Server-side verification ───────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VerifyRequest<'a> {
    id_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyResponse {
    email: Option<String>,
    display_name: Option<String>,
}

/// Ask the backend to verify the ID token and tell us who it is about.
///
/// The desktop decoding its own claims would prove only that the token is
/// well-formed JSON. The signature, the audience, and whether the subject is a
/// person this deployment has ever seen are all questions only the backend can
/// answer, and all three have to be true before a person is shown a name and
/// asked to accept it.
async fn verify_with_backend(tokens: &CognitoTokens) -> Result<VerifiedIdentity, String> {
    let id_token = tokens
        .id_token
        .as_deref()
        .ok_or_else(|| "CONTINUATION_TOKEN_MISMATCH".to_string())?;

    let response = build_client()
        .post(endpoints().session_verify_url())
        .header("authorization", format!("Bearer {}", tokens.access_token))
        .json(&VerifyRequest { id_token })
        .send()
        .await
        .map_err(|_| "CONTINUATION_OFFLINE".to_string())?;

    if !response.status().is_success() {
        // The body may carry a provider message. It is not shown and not
        // logged: an error string from an unauthenticated boundary is
        // attacker-influenced text, and this one has a fixed code instead.
        return Err("CONTINUATION_NOT_VERIFIED".to_string());
    }

    let body: VerifyResponse = response
        .json()
        .await
        .map_err(|_| "CONTINUATION_NOT_VERIFIED".to_string())?;

    let email = body
        .email
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "CONTINUATION_NOT_VERIFIED".to_string())?;

    Ok(VerifiedIdentity {
        email,
        display_name: body
            .display_name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
    })
}

#[cfg(test)]
mod authenticated_receipt_tests {
    use super::*;

    fn receipt(
        endpoint: AuthenticatedReceiptEndpoint,
        event_id: &str,
        occurred_at: &str,
    ) -> AuthenticatedDesktopReceipt {
        AuthenticatedDesktopReceipt {
            endpoint,
            body: serde_json::json!({
                "eventId": event_id,
                "occurredAt": occurred_at,
                "installAttemptId": "install_123",
            }),
            authorized_account_id: Some("person-a".to_string()),
            attempts: 0,
            next_attempt_at_ms: 0,
        }
    }

    #[test]
    fn authenticated_receipt_queue_keeps_original_ids_and_timestamps_for_retries() {
        let home = tempfile::tempdir().expect("temp home");
        let path = authenticated_receipt_queue_path_from_home(home.path());
        let expected = vec![
            receipt(
                AuthenticatedReceiptEndpoint::SessionActivated,
                "evt_login",
                "2026-09-17T10:00:00.000Z",
            ),
            receipt(
                AuthenticatedReceiptEndpoint::WorkspaceSelected,
                "evt_workspace",
                "2026-09-17T10:01:00.000Z",
            ),
        ];

        write_authenticated_receipt_queue(&path, &expected).expect("persist queue before delivery");
        let replay = read_authenticated_receipt_queue(&path).expect("reload queued receipts");

        assert_eq!(replay, expected);
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the committed queue must not leave a partial file behind"
        );
    }

    #[test]
    fn authenticated_receipt_queue_refuses_an_unknown_schema_without_erasing_it() {
        let home = tempfile::tempdir().expect("temp home");
        let path = authenticated_receipt_queue_path_from_home(home.path());
        fs::create_dir_all(path.parent().expect("queue parent")).expect("create queue parent");
        fs::write(&path, r#"{"version":99,"receipts":[]}"#).expect("seed unknown version");

        let error = read_authenticated_receipt_queue(&path)
            .expect_err("unknown queue is not safe to overwrite");

        assert!(error.contains("unsupported desktop receipt queue version"));
        assert!(
            path.exists(),
            "the unknown queue remains available for a future migration"
        );
    }

    #[test]
    fn legacy_unbound_receipts_are_read_but_cannot_cross_an_account_switch() {
        let legacy: AuthenticatedDesktopReceipt = serde_json::from_value(serde_json::json!({
            "endpoint": "workspace_selected",
            "body": { "eventId": "evt_legacy" },
        }))
        .expect("legacy queue row");

        assert_eq!(legacy.authorized_account_id, None);
        assert!(!may_deliver_for_account(
            legacy.authorized_account_id.as_deref(),
            Some("person-b"),
        ));
    }

    #[test]
    fn drain_keeps_a_receipt_enqueued_while_an_older_one_is_in_flight() {
        let delivered = receipt(
            AuthenticatedReceiptEndpoint::SessionActivated,
            "evt_login",
            "2026-09-17T10:00:00.000Z",
        );
        let queued_during_delivery = receipt(
            AuthenticatedReceiptEndpoint::WorkspaceSelected,
            "evt_workspace",
            "2026-09-17T10:01:00.000Z",
        );

        let remaining = without_terminal_receipts(
            vec![delivered.clone(), queued_during_delivery.clone()],
            &[delivered],
        );

        assert_eq!(remaining, vec![queued_during_delivery]);
    }
}
