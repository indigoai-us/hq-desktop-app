//! Connect and sign in to the local agent CLIs (Claude, Codex, Grok).
//!
//! Extracted from the former `agent_session::provider_auth` when the in-app
//! Sessions feature was removed. The Sessions runtime is gone, but Settings →
//! AI tools and Settings → Bots still install these CLIs and sign the user in,
//! so this module — and only this module — survived the removal.

pub mod preflight;
mod programs;
mod status;

/// Which agent CLI to connect. Wire spelling is `claude` / `codex` / `grok`.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SessionTool {
    Claude,
    Codex,
    Grok,
}

impl SessionTool {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionTool::Claude => "claude",
            SessionTool::Codex => "codex",
            SessionTool::Grok => "grok",
        }
    }
}

use crate::commands::launch;
use hq_desktop_core::paths;
use serde::Serialize;
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex as SyncMutex, OnceLock},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Child,
    sync::{oneshot, Mutex},
    task::JoinHandle,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
pub struct LoginState {
    pub state: &'static str,
    pub message: Option<&'static str>,
}
fn state(value: &'static str, message: Option<&'static str>) -> LoginState {
    LoginState {
        state: value,
        message,
    }
}
struct Attempt {
    state: Arc<SyncMutex<LoginState>>,
    cancel: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}
type Attempts = Mutex<HashMap<&'static str, Attempt>>;
fn attempts() -> &'static Attempts {
    static ATTEMPTS: OnceLock<Attempts> = OnceLock::new();
    ATTEMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn key(tool: SessionTool) -> &'static str {
    tool.as_str()
}
async fn program(tool: SessionTool) -> Result<String, String> {
    lookup(tool).await.map(|lookup| lookup.path)
}

/// The program a runtime would spawn, AND whether one was actually found.
async fn lookup(tool: SessionTool) -> Result<programs::ProgramLookup, String> {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || match tool {
            SessionTool::Claude => programs::claude_lookup(),
            SessionTool::Codex => programs::codex_lookup(),
            SessionTool::Grok => programs::grok_lookup(),
        }),
    )
    .await
    .map_err(|_| "Provider lookup timed out. Please retry.".to_owned())?
    .map_err(|_| "Provider lookup failed. Please retry.".to_owned())
}
async fn command(program: &str, args: &[&str]) -> Result<tokio::process::Command, ()> {
    let program = program.to_owned();
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || {
            let mut command = paths::tokio_spawn_command(
                &program,
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
            );
            command
                .env("PATH", paths::child_path())
                .stdin(Stdio::null())
                .kill_on_drop(true);
            apply_account_env(
                &mut command,
                account_name(std::env::var("USER").ok(), passwd_login_name).as_deref(),
            );
            #[cfg(unix)]
            command.process_group(0);
            command
        }),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}
/// The login account name the agent CLIs must see as `$USER`.
///
/// The Claude Code CLI resolves its macOS Keychain credentials under an
/// account name taken from `$USER`, falling back to the literal `"unknown"`
/// when the variable is absent — so a probe spawned from a process whose
/// environment carries no `USER` reads a DIFFERENT keychain item than the
/// user's terminal and reports a signed-in CLI as signed out. Codex and Grok
/// read a file under `$HOME` instead, which is why only Claude Code showed as
/// "not signed in on this Mac" while Codex was detected correctly.
///
/// An explicit `USER` in the app's own environment always wins; the passwd
/// database is consulted only when it is missing or blank, and a lookup that
/// finds nothing leaves the child's environment untouched rather than
/// inventing a name.
fn account_name(
    env_user: Option<String>,
    lookup: impl FnOnce() -> Option<String>,
) -> Option<String> {
    let trimmed = |value: String| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    };
    match env_user.and_then(trimmed) {
        Some(user) => Some(user),
        None => lookup().and_then(trimmed),
    }
}

/// Set `USER`/`LOGNAME` on a child when an account name is known. Separate
/// from [`account_name`] so the spawned-child behaviour is testable without
/// mutating the process environment (racy under a parallel test harness).
fn apply_account_env(command: &mut tokio::process::Command, name: Option<&str>) {
    if let Some(name) = name {
        command.env("USER", name).env("LOGNAME", name);
    }
}

/// This process's login name from the passwd database. `getpwuid_r` (not
/// `getpwuid`) because the provider probes run concurrently on the blocking
/// pool and the non-reentrant form shares one static buffer between them.
#[cfg(unix)]
fn passwd_login_name() -> Option<String> {
    let mut buffer = vec![0 as libc::c_char; 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: `getpwuid_r` writes only into caller-owned storage (`entry` and
    // `buffer`), and sets `found` non-null only when `entry` was populated —
    // `pw_name` then points into `buffer`, which outlives the read below.
    let code = unsafe {
        libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if code != 0 || found.is_null() || entry.pw_name.is_null() {
        return None;
    }
    // SAFETY: `pw_name` is a NUL-terminated string inside `buffer`.
    let name = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) };
    name.to_str().ok().map(str::to_owned)
}

#[cfg(not(unix))]
fn passwd_login_name() -> Option<String> {
    None
}

/// Why a probe could not answer. Kept apart from "answered: signed out",
/// because collapsing the two is the whole defect: a CLI that is not on this
/// Mac, and a probe that could not run, both used to arrive in the New bot
/// wizard as "Claude Code · not signed in" with a Sign in that cannot work.
///
/// `missing` is the spawn-level "no such file": the resolver handed back a
/// path (often the bare name) and the loader could not find it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeError {
    pub reason: String,
    pub missing: bool,
}

impl ProbeError {
    fn failed(reason: &str) -> Self {
        Self {
            reason: reason.to_owned(),
            missing: false,
        }
    }
}

/// What the app knows about one runtime CLI on this Mac.
///
/// Serialized as a discriminated union (`{"state":"notInstalled","searched":[…]}`)
/// so the UI can label, explain and gate each case separately instead of
/// reading two booleans that cannot tell them apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum RuntimeStatus {
    /// Installed here and signed in — the only state a bot can be created on.
    SignedIn,
    /// Installed here, and the CLI itself says it is signed out. Sign in works.
    SignedOut,
    /// No such CLI on this Mac. Signing in cannot help; installing it can.
    /// `searched` names the directories the lookup walked, so a person who
    /// installed it somewhere unusual can see why HQ missed it.
    NotInstalled { searched: Vec<String> },
    /// The CLI is here but the probe could not get an answer out of it (it
    /// timed out, died, or printed something unreadable). `reason` is a short
    /// plain phrase; it never carries CLI output, which could hold credentials.
    ProbeFailed { reason: String },
}

impl RuntimeStatus {
    pub fn is_signed_in(&self) -> bool {
        matches!(self, RuntimeStatus::SignedIn)
    }

    /// True when a binary was found here, whatever the sign-in answer was.
    /// The UI offers "Sign in" on exactly this.
    pub fn is_installed(&self) -> bool {
        !matches!(self, RuntimeStatus::NotInstalled { .. })
    }
}

/// Fold a lookup and a probe into one state. Pure, so every arm is unit-tested
/// without spawning a CLI.
fn classify_runtime(
    found: bool,
    probe: Result<bool, ProbeError>,
    searched: impl FnOnce() -> Vec<String>,
) -> RuntimeStatus {
    if !found {
        return RuntimeStatus::NotInstalled {
            searched: searched(),
        };
    }
    match probe {
        Ok(true) => RuntimeStatus::SignedIn,
        Ok(false) => RuntimeStatus::SignedOut,
        // A path that resolved a moment ago and will not spawn now (removed
        // mid-flight, or a resolver hit that is not executable) is absence,
        // not a failed check — offering Sign in for it would go nowhere.
        Err(error) if error.missing => RuntimeStatus::NotInstalled {
            searched: searched(),
        },
        Err(error) => RuntimeStatus::ProbeFailed {
            reason: error.reason,
        },
    }
}

/// The directories a lookup walks here, as strings, for the not-installed
/// explanation. Capped so a long list cannot bloat the preflight payload, but
/// high enough to include the whole list today — a cap that truncated it would
/// hide the very directories a person with an unusual install needs to see.
fn searched_dirs() -> Vec<String> {
    paths::program_search_dirs()
        .into_iter()
        .take(32)
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect()
}

/// The full state of one runtime: resolve it, then ask it.
pub async fn runtime_status(tool: SessionTool) -> RuntimeStatus {
    let lookup = match lookup(tool).await {
        Ok(lookup) => lookup,
        Err(reason) => return RuntimeStatus::ProbeFailed { reason },
    };
    if !lookup.found {
        return RuntimeStatus::NotInstalled {
            searched: searched_dirs(),
        };
    }
    classify_runtime(true, probe_detail(tool, &lookup.path).await, searched_dirs)
}

async fn stop(child: &mut Child) {
    #[cfg(unix)]
    if let Some(id) = child.id() {
        // Each child is launched in its own group, never the app's group.
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(id as i32),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}
/// [`probe_detail`] with the reason discarded, for the callers that only need
/// the yes/no answer they always took.
async fn probe(tool: SessionTool, program: &str) -> Result<bool, ()> {
    probe_detail(tool, program).await.map_err(|_| ())
}

async fn probe_detail(tool: SessionTool, program: &str) -> Result<bool, ProbeError> {
    let args: &[&str] = match tool {
        SessionTool::Claude => &["auth", "status", "--json"],
        SessionTool::Codex => &["login", "status"],
        SessionTool::Grok => &["models"],
    };
    let mut child = command(program, args)
        .await
        .map_err(|()| ProbeError::failed("the lookup timed out"))?
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| ProbeError {
            missing: error.kind() == std::io::ErrorKind::NotFound,
            reason: if error.kind() == std::io::ErrorKind::NotFound {
                "the command was not found".to_owned()
            } else {
                // The OS error kind only — never the message, which can name a
                // path inside the person's home directory.
                format!("it could not be started ({:?})", error.kind())
            },
        })?;
    let unreadable = || ProbeError::failed("its answer could not be read");
    let mut stdout = child.stdout.take().ok_or_else(unreadable)?.take(65536);
    let mut stderr = child.stderr.take().ok_or_else(unreadable)?.take(65536);
    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_result, err_result, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        );
        out_result.map_err(|_| unreadable())?;
        err_result.map_err(|_| unreadable())?;
        let success = status.map_err(|_| unreadable())?.success();
        match tool {
            SessionTool::Claude => serde_json::from_slice::<serde_json::Value>(&out)
                .ok()
                .and_then(|value| value.get("loggedIn").and_then(|flag| flag.as_bool()))
                .map(|logged_in| success && logged_in)
                .ok_or_else(unreadable),
            SessionTool::Codex => {
                let logged_in = status::codex_login_status_succeeded(success, &out, &err);
                let streams = [out, err];
                if logged_in {
                    Ok(true)
                } else if streams.iter().any(|text| {
                    String::from_utf8_lossy(text)
                        .lines()
                        .any(|line| line.trim() == "Not logged in")
                }) {
                    Ok(false)
                } else {
                    Err(unreadable())
                }
            }
            SessionTool::Grok => {
                status::grok_login_status_succeeded(success, &out, &err).map_err(|()| unreadable())
            }
        }
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            stop(&mut child).await;
            Err(ProbeError::failed("it did not answer in time"))
        }
    }
}
pub async fn logged_in(tool: SessionTool) -> bool {
    match program(tool).await {
        Ok(program) => probe(tool, &program).await.unwrap_or(false),
        Err(_) => false,
    }
}
async fn run_login(
    tool: SessionTool,
    program: String,
    status: Arc<SyncMutex<LoginState>>,
    mut cancel: oneshot::Receiver<()>,
    deadline: Duration,
    force: bool,
) {
    let args: &[&str] = match tool {
        SessionTool::Claude => &["auth", "login"],
        SessionTool::Codex => &["login"],
        SessionTool::Grok => &["login"],
    };
    if cancel.try_recv().is_ok() {
        *status.lock().unwrap() = state("disconnected", Some("Sign-in cancelled."));
        return;
    }
    if force && tool == SessionTool::Claude {
        if let Ok(mut logout) = command(&program, &["auth", "logout"]).await {
            if let Ok(mut child) = logout.stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
                let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
                let _ = child.kill().await;
            }
        }
    }
    let mut login = match command(&program, args).await {
        Ok(login) => login,
        Err(()) => {
            *status.lock().unwrap() =
                state("error", Some("Provider lookup timed out. Please retry."));
            return;
        }
    };
    let Ok(mut child) = login.stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
        *status.lock().unwrap() = state(
            "error",
            Some("Could not start sign-in. Check that the provider is installed and retry."),
        );
        return;
    };
    let result = tokio::select! {
        _ = &mut cancel => { stop(&mut child).await; state("disconnected", Some("Sign-in cancelled.")) },
        _ = tokio::time::sleep(deadline) => { stop(&mut child).await; state("error", Some("Sign-in timed out. Please retry.")) },
        exit = child.wait() => {
            if exit.is_ok_and(|exit| exit.success()) && probe(tool, &program).await.unwrap_or(false) {
                state("connected", None)
            } else { state("error", Some("Sign-in did not complete. Please retry.")) }
        }
    };
    *status.lock().unwrap() = result;
}
async fn start_with(
    attempts: &Attempts,
    tool: SessionTool,
    program: String,
    deadline: Duration,
    force: bool,
) -> LoginState {
    // Serialize start/probe/cancel so repeated clicks can never create two browser flows.
    let mut attempts = attempts.lock().await;
    if let Some(attempt) = attempts.get(key(tool)) {
        if !attempt.task.is_finished() {
            return attempt.state.lock().unwrap().clone();
        }
    }
    match probe(tool, &program).await {
        Ok(true) if !force => {
            attempts.remove(key(tool));
            return state("connected", None);
        }
        Err(()) => {
            return state(
                "error",
                Some("Could not check sign-in. Check that the provider is installed and retry."),
            )
        }
        Ok(_) => {}
    }
    let status = Arc::new(SyncMutex::new(state(
        "waiting",
        Some("Complete sign-in in your browser."),
    )));
    let (cancel, receiver) = oneshot::channel();
    let task = tokio::spawn(run_login(
        tool,
        program,
        status.clone(),
        receiver,
        deadline,
        force,
    ));
    let result = status.lock().unwrap().clone();
    attempts.insert(
        key(tool),
        Attempt {
            state: status,
            cancel: Some(cancel),
            task,
        },
    );
    result
}
#[tauri::command]
pub async fn agent_provider_login_start(
    tool: SessionTool,
    force: Option<bool>,
) -> Result<LoginState, String> {
    Ok(start_with(
        attempts(),
        tool,
        program(tool).await?,
        LOGIN_TIMEOUT,
        force.unwrap_or(false),
    )
    .await)
}
#[tauri::command]
pub async fn agent_provider_login_status(tool: SessionTool) -> Result<LoginState, String> {
    let attempts = attempts().lock().await;
    let previous = if let Some(attempt) = attempts.get(key(tool)) {
        let previous = attempt.state.lock().unwrap().clone();
        if !attempt.task.is_finished() {
            return Ok(previous);
        }
        Some(previous)
    } else {
        None
    };
    Ok(match probe(tool, &program(tool).await?).await {
        Ok(true) => state("connected", None),
        Ok(false) => previous
            .filter(|previous| previous.state == "error")
            .unwrap_or_else(|| state("disconnected", None)),
        Err(()) => state("error", Some("Could not check sign-in. Please retry.")),
    })
}
async fn cancel_with(attempts: &Attempts, tool: SessionTool) -> LoginState {
    let mut attempts = attempts.lock().await;
    if let Some(mut attempt) = attempts.remove(key(tool)) {
        if let Some(cancel) = attempt.cancel.take() {
            let _ = cancel.send(());
        }
        let _ = attempt.task.await;
        return attempt.state.lock().unwrap().clone();
    }
    state("disconnected", None)
}
#[tauri::command]
pub async fn agent_provider_login_cancel(tool: SessionTool) -> Result<LoginState, String> {
    Ok(cancel_with(attempts(), tool).await)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn searched() -> Vec<String> {
        vec!["/opt/homebrew/bin".to_owned()]
    }

    /// The four states the wizard used to collapse into "not signed in".
    #[test]
    fn each_runtime_state_is_told_apart() {
        assert_eq!(
            classify_runtime(true, Ok(true), searched),
            RuntimeStatus::SignedIn
        );
        assert_eq!(
            classify_runtime(true, Ok(false), searched),
            RuntimeStatus::SignedOut
        );
        assert_eq!(
            classify_runtime(false, Ok(true), searched),
            RuntimeStatus::NotInstalled {
                searched: searched()
            },
            "a lookup that found nothing is not installed, whatever a probe says"
        );
        assert_eq!(
            classify_runtime(true, Err(ProbeError::failed("it did not answer in time")), searched),
            RuntimeStatus::ProbeFailed {
                reason: "it did not answer in time".to_owned()
            }
        );
    }

    /// A path that resolved and then would not spawn is absence, not a failed
    /// check: offering Sign in for it is the dead end this change removes.
    #[test]
    fn a_vanished_binary_reads_as_not_installed_not_as_a_failed_check() {
        let status = classify_runtime(
            true,
            Err(ProbeError {
                reason: "the command was not found".to_owned(),
                missing: true,
            }),
            searched,
        );
        assert_eq!(
            status,
            RuntimeStatus::NotInstalled {
                searched: searched()
            }
        );
        assert!(!status.is_installed());
        assert!(!status.is_signed_in());
    }

    /// Sign in is offered on `is_installed`, so every state must answer it the
    /// way the UI needs: only the missing one hides the button.
    #[test]
    fn only_a_missing_runtime_is_not_installed() {
        assert!(RuntimeStatus::SignedIn.is_installed());
        assert!(RuntimeStatus::SignedOut.is_installed());
        assert!(RuntimeStatus::ProbeFailed {
            reason: "x".to_owned()
        }
        .is_installed());
        assert!(!RuntimeStatus::NotInstalled { searched: vec![] }.is_installed());

        assert!(RuntimeStatus::SignedIn.is_signed_in());
        for other in [
            RuntimeStatus::SignedOut,
            RuntimeStatus::ProbeFailed {
                reason: "x".to_owned(),
            },
            RuntimeStatus::NotInstalled { searched: vec![] },
        ] {
            assert!(!other.is_signed_in());
        }
    }

    /// The wire shape the UI parses. A renamed arm or field silently turns
    /// every runtime into the UI's "unknown → treat as ready" fallback.
    #[test]
    fn the_status_serializes_as_a_discriminated_union() {
        let signed_in = serde_json::to_value(RuntimeStatus::SignedIn).unwrap();
        assert_eq!(signed_in, serde_json::json!({ "state": "signedIn" }));
        assert_eq!(
            serde_json::to_value(RuntimeStatus::SignedOut).unwrap(),
            serde_json::json!({ "state": "signedOut" })
        );
        assert_eq!(
            serde_json::to_value(RuntimeStatus::NotInstalled {
                searched: vec!["/opt/homebrew/bin".to_owned()]
            })
            .unwrap(),
            serde_json::json!({ "state": "notInstalled", "searched": ["/opt/homebrew/bin"] })
        );
        assert_eq!(
            serde_json::to_value(RuntimeStatus::ProbeFailed {
                reason: "it did not answer in time".to_owned()
            })
            .unwrap(),
            serde_json::json!({ "state": "probeFailed", "reason": "it did not answer in time" })
        );
    }

    /// A probe failure is surfaced to the person, so it must never be able to
    /// carry what the CLI printed — that is where a token would be.
    #[tokio::test]
    async fn a_probe_failure_reason_never_carries_cli_output() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider");
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf 'sk-secret-token-value'\nprintf 'sk-secret-on-stderr' >&2\nexit 3\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let program = path.to_string_lossy().into_owned();

        let error = probe_detail(SessionTool::Claude, &program)
            .await
            .expect_err("unparseable output is not an answer");
        assert!(!error.reason.contains("sk-secret"));
        assert!(!error.missing);
        assert_eq!(error.reason, "its answer could not be read");

        match classify_runtime(true, Err(error), searched) {
            RuntimeStatus::ProbeFailed { reason } => assert!(!reason.contains("sk-")),
            other => panic!("expected a probe failure, got {other:?}"),
        }
    }

    /// The end-to-end absence path: nothing on disk under that name.
    #[tokio::test]
    async fn a_binary_that_is_not_on_disk_reports_missing_rather_than_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("definitely-not-here").to_string_lossy().into_owned();
        let error = probe_detail(SessionTool::Claude, &program)
            .await
            .expect_err("a missing binary cannot answer");
        assert!(error.missing);
        assert_eq!(
            classify_runtime(true, Err(error), searched),
            RuntimeStatus::NotInstalled {
                searched: searched()
            }
        );
    }
    fn fake(tool: SessionTool, login: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider");
        let signed_in = match tool {
            SessionTool::Claude => "printf '{\"loggedIn\":true}'",
            SessionTool::Codex => "printf 'Logged in using ChatGPT\\n' >&2",
            SessionTool::Grok => "printf 'You are logged in with grok.com.\\n'",
        };
        let signed_out = match tool {
            SessionTool::Claude => "printf '{\"loggedIn\":false}'; exit 1",
            SessionTool::Codex => "printf 'Not logged in\\n' >&2; exit 1",
            SessionTool::Grok => "printf 'Not logged in. Run `grok login`.\\n' >&2; exit 1",
        };
        std::fs::write(&path, format!("#!/bin/sh\ncd '{}'\ncase \"$*\" in\n'auth status --json'|'login status'|'models')\nif [ -f connected ]; then {signed_in}; else {signed_out}; fi;;\n'auth logout')\nrm -f connected;;\n'auth login'|'login')\nprintf 'login\\n' >> calls\n{login};;\n*) exit 9;;\nesac\n", dir.path().display())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        (dir, path.to_string_lossy().into_owned())
    }
    async fn finished(attempts: &Attempts, tool: SessionTool) -> LoginState {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let result = attempts
                    .lock()
                    .await
                    .get(key(tool))
                    .unwrap()
                    .state
                    .lock()
                    .unwrap()
                    .clone();
                if result.state != "waiting" {
                    return result;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn both_providers_use_their_vendor_status_and_login_commands() {
        for tool in [SessionTool::Claude, SessionTool::Codex, SessionTool::Grok] {
            let (_dir, program) = fake(tool, "touch connected; exit 0");
            let attempts = Attempts::default();
            assert!(!probe(tool, &program).await.unwrap());
            assert_eq!(
                start_with(&attempts, tool, program.clone(), LOGIN_TIMEOUT, false)
                    .await
                    .state,
                "waiting"
            );
            assert_eq!(finished(&attempts, tool).await.state, "connected");
            assert!(probe(tool, &program).await.unwrap());
        }
    }
    #[tokio::test]
    async fn existing_account_is_never_replaced() {
        let (dir, program) = fake(SessionTool::Claude, "exit 9");
        std::fs::write(dir.path().join("connected"), "existing account").unwrap();
        assert_eq!(
            start_with(
                &Attempts::default(),
                SessionTool::Claude,
                program,
                LOGIN_TIMEOUT,
                false,
            )
            .await
            .state,
            "connected"
        );
        assert!(!dir.path().join("calls").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("connected")).unwrap(),
            "existing account"
        );
    }
    #[tokio::test]
    async fn force_reauth_replaces_a_stale_login() {
        let (dir, program) = fake(SessionTool::Claude, "touch connected; exit 0");
        std::fs::write(dir.path().join("connected"), "stale").unwrap();
        let attempts = Attempts::default();
        assert_eq!(
            start_with(
                &attempts,
                SessionTool::Claude,
                program,
                LOGIN_TIMEOUT,
                true,
            )
            .await
            .state,
            "waiting"
        );
        assert_eq!(finished(&attempts, SessionTool::Claude).await.state, "connected");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls")).unwrap(),
            "login\n"
        );
    }
    #[tokio::test]
    async fn repeated_clicks_are_single_flight_and_cancel_reaps_child() {
        let (dir, program) = fake(SessionTool::Codex, "echo $$ > pid; sleep 60");
        let attempts = Attempts::default();
        start_with(
            &attempts,
            SessionTool::Codex,
            program.clone(),
            LOGIN_TIMEOUT,
            false,
        )
        .await;
        start_with(&attempts, SessionTool::Codex, program, LOGIN_TIMEOUT, false).await;
        for _ in 0..100 {
            if dir.path().join("pid").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let pid: i32 = std::fs::read_to_string(dir.path().join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(
            cancel_with(&attempts, SessionTool::Codex).await.state,
            "disconnected"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls")).unwrap(),
            "login\n"
        );
        assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
    }
    #[tokio::test]
    async fn timed_out_flow_can_be_retried_without_stale_attempt() {
        let (dir, program) = fake(SessionTool::Codex, "sleep 60");
        let attempts = Attempts::default();
        start_with(
            &attempts,
            SessionTool::Codex,
            program.clone(),
            Duration::from_millis(40),
            false,
        )
        .await;
        assert_eq!(
            finished(&attempts, SessionTool::Codex).await.message,
            Some("Sign-in timed out. Please retry.")
        );
        assert_eq!(
            start_with(
                &attempts,
                SessionTool::Codex,
                program,
                Duration::from_millis(40),
                false,
            )
            .await
            .state,
            "waiting"
        );
        finished(&attempts, SessionTool::Codex).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("calls")).unwrap(),
            "login\nlogin\n"
        );
    }
    #[tokio::test]
    async fn failed_cli_output_is_not_exposed() {
        let (_dir, program) = fake(
            SessionTool::Claude,
            "echo 'secret-token-private-url' >&2; exit 1",
        );
        let attempts = Attempts::default();
        start_with(&attempts, SessionTool::Claude, program, LOGIN_TIMEOUT, false).await;
        let reply = finished(&attempts, SessionTool::Claude).await;
        assert_eq!(reply.state, "error");
        assert!(!serde_json::to_string(&reply)
            .unwrap()
            .contains("secret-token"));
    }
    #[tokio::test]
    async fn successful_exit_without_real_auth_is_not_connected() {
        let (_dir, program) = fake(SessionTool::Claude, "exit 0");
        let attempts = Attempts::default();
        start_with(&attempts, SessionTool::Claude, program, LOGIN_TIMEOUT, false).await;
        assert_eq!(
            finished(&attempts, SessionTool::Claude).await.state,
            "error"
        );
    }

    /// HQ-DESKTOP: the New bot wizard said "Claude Code is not signed in on
    /// this Mac" on a Mac whose CLI was signed in. The Claude Code CLI keys its
    /// macOS Keychain credentials by `$USER`, so a probe spawned without that
    /// variable read a different (empty) keychain account and reported the user
    /// as signed out. Codex reads a file under $HOME, which is why only Claude
    /// was affected.
    #[tokio::test]
    async fn probe_child_is_given_the_login_account_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider");
        // Signed-in only when the child can see an account name, exactly as the
        // real CLI's keychain lookup behaves.
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nprintf '%s' \"$USER\" > '{dir}/seen-user'\nprintf '%s' \"$LOGNAME\" > '{dir}/seen-logname'\nif [ -n \"$USER\" ]; then printf '{{\"loggedIn\":true}}'; else printf '{{\"loggedIn\":false}}'; exit 1; fi\n",
                dir = dir.path().display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let program = path.to_string_lossy().into_owned();

        assert!(probe(SessionTool::Claude, &program).await.unwrap());
        let seen = std::fs::read_to_string(dir.path().join("seen-user")).unwrap();
        assert!(!seen.trim().is_empty(), "child saw no USER");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("seen-logname")).unwrap(),
            seen
        );
    }

    #[tokio::test]
    async fn account_env_is_set_from_the_resolved_name_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider");
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\nprintf '%s' \"$USER\" > '{}/seen-user'\n",
                dir.path().display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();

        let mut cmd = tokio::process::Command::new(&path);
        apply_account_env(&mut cmd, Some("fixture-user"));
        cmd.status().await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("seen-user")).unwrap(),
            "fixture-user"
        );
    }

    #[test]
    fn an_explicit_user_wins_and_a_blank_one_falls_back() {
        assert_eq!(
            account_name(Some("corey".into()), || panic!("passwd must not be read")),
            Some("corey".to_owned())
        );
        assert_eq!(
            account_name(Some("  ".into()), || Some("from-passwd".into())),
            Some("from-passwd".to_owned())
        );
        assert_eq!(account_name(None, || Some("from-passwd".into())), Some("from-passwd".to_owned()));
        // Nothing known: leave the child's environment alone rather than
        // inventing an account name that would read the wrong keychain item.
        assert_eq!(account_name(None, || None), None);
        assert_eq!(account_name(None, || Some("  ".into())), None);
    }

    /// A signed-out CLI must still read as signed out — the fix must not turn
    /// "could not tell" into "connected".
    #[tokio::test]
    async fn a_truly_signed_out_cli_is_still_reported_signed_out() {
        let (_dir, program) = fake(SessionTool::Claude, "exit 0");
        assert!(!probe(SessionTool::Claude, &program).await.unwrap());
    }

    #[tokio::test]
    async fn cancellation_before_spawn_never_opens_browser() {
        let (dir, program) = fake(SessionTool::Claude, "touch connected; exit 0");
        let status = Arc::new(SyncMutex::new(state("waiting", None)));
        let (cancel, receiver) = oneshot::channel();
        cancel.send(()).unwrap();
        run_login(
            SessionTool::Claude,
            program,
            status.clone(),
            receiver,
            LOGIN_TIMEOUT,
            false,
        )
        .await;
        assert_eq!(status.lock().unwrap().state, "disconnected");
        assert!(!dir.path().join("calls").exists());
    }

    #[tokio::test]
    async fn unknown_probe_does_not_start_login() {
        let (dir, program) = fake(SessionTool::Codex, "touch connected; exit 0");
        std::fs::write(
            &program,
            "#!/bin/sh\necho 'temporary failure' >&2\nexit 2\n",
        )
        .unwrap();
        let result = start_with(
            &Attempts::default(),
            SessionTool::Codex,
            program,
            LOGIN_TIMEOUT,
            false,
        )
        .await;
        assert_eq!(result.state, "error");
        assert!(!dir.path().join("calls").exists());
    }
}
