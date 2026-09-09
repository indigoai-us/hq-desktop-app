//! Vendor-owned browser login. HQ never parses OAuth URLs or handles credentials.
use hq_desktop_core::{agent_session::types::SessionTool, paths};
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
    match tool {
        SessionTool::Claude => "claude",
        SessionTool::Codex => "codex",
    }
}
async fn program(tool: SessionTool) -> Result<String, String> {
    tokio::time::timeout(
        PROBE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || match tool {
            SessionTool::Claude => super::claude::claude_program(),
            SessionTool::Codex => super::codex::codex_program(),
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
            #[cfg(unix)]
            command.process_group(0);
            command
        }),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
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
async fn probe(tool: SessionTool, program: &str) -> Result<bool, ()> {
    let args: &[&str] = match tool {
        SessionTool::Claude => &["auth", "status", "--json"],
        SessionTool::Codex => &["login", "status"],
    };
    let mut child = command(program, args)
        .await?
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| ())?;
    let mut stdout = child.stdout.take().ok_or(())?.take(65536);
    let mut stderr = child.stderr.take().ok_or(())?.take(65536);
    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (out_result, err_result, status) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            child.wait()
        );
        out_result.map_err(|_| ())?;
        err_result.map_err(|_| ())?;
        let success = status.map_err(|_| ())?.success();
        match tool {
            SessionTool::Claude => serde_json::from_slice::<serde_json::Value>(&out)
                .ok()
                .and_then(|value| value.get("loggedIn").and_then(|flag| flag.as_bool()))
                .map(|logged_in| success && logged_in)
                .ok_or(()),
            SessionTool::Codex => {
                let logged_in = super::codex::login_status_succeeded(success, &out, &err);
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
                    Err(())
                }
            }
        }
    })
    .await;
    match result {
        Ok(result) => result,
        Err(_) => {
            stop(&mut child).await;
            Err(())
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
) {
    let args: &[&str] = match tool {
        SessionTool::Claude => &["auth", "login"],
        SessionTool::Codex => &["login"],
    };
    let mut command = match command(&program, args).await {
        Ok(command) => command,
        Err(()) => {
            *status.lock().unwrap() =
                state("error", Some("Provider lookup timed out. Please retry."));
            return;
        }
    };
    if cancel.try_recv().is_ok() {
        *status.lock().unwrap() = state("disconnected", Some("Sign-in cancelled."));
        return;
    }
    let Ok(mut child) = command.stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
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
) -> LoginState {
    // Serialize start/probe/cancel so repeated clicks can never create two browser flows.
    let mut attempts = attempts.lock().await;
    if let Some(attempt) = attempts.get(key(tool)) {
        if !attempt.task.is_finished() {
            return attempt.state.lock().unwrap().clone();
        }
    }
    match probe(tool, &program).await {
        Ok(true) => {
            attempts.remove(key(tool));
            return state("connected", None);
        }
        Err(()) => {
            return state(
                "error",
                Some("Could not check sign-in. Check that the provider is installed and retry."),
            )
        }
        Ok(false) => {}
    }
    let status = Arc::new(SyncMutex::new(state(
        "waiting",
        Some("Complete sign-in in your browser."),
    )));
    let (cancel, receiver) = oneshot::channel();
    let task = tokio::spawn(run_login(tool, program, status.clone(), receiver, deadline));
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
pub async fn agent_provider_login_start(tool: SessionTool) -> Result<LoginState, String> {
    Ok(start_with(attempts(), tool, program(tool).await?, LOGIN_TIMEOUT).await)
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
    fn fake(tool: SessionTool, login: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider");
        let signed_in = match tool {
            SessionTool::Claude => "printf '{\"loggedIn\":true}'",
            SessionTool::Codex => "printf 'Logged in using ChatGPT\\n' >&2",
        };
        let signed_out = match tool {
            SessionTool::Claude => "printf '{\"loggedIn\":false}'; exit 1",
            SessionTool::Codex => "printf 'Not logged in\\n' >&2; exit 1",
        };
        std::fs::write(&path, format!("#!/bin/sh\ncd '{}'\ncase \"$*\" in\n'auth status --json'|'login status')\nif [ -f connected ]; then {signed_in}; else {signed_out}; fi;;\n'auth login'|'login')\nprintf 'login\\n' >> calls\n{login};;\n*) exit 9;;\nesac\n", dir.path().display())).unwrap();
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
        for tool in [SessionTool::Claude, SessionTool::Codex] {
            let (_dir, program) = fake(tool, "touch connected; exit 0");
            let attempts = Attempts::default();
            assert!(!probe(tool, &program).await.unwrap());
            assert_eq!(
                start_with(&attempts, tool, program.clone(), LOGIN_TIMEOUT)
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
                LOGIN_TIMEOUT
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
    async fn repeated_clicks_are_single_flight_and_cancel_reaps_child() {
        let (dir, program) = fake(SessionTool::Codex, "echo $$ > pid; sleep 60");
        let attempts = Attempts::default();
        start_with(
            &attempts,
            SessionTool::Codex,
            program.clone(),
            LOGIN_TIMEOUT,
        )
        .await;
        start_with(&attempts, SessionTool::Codex, program, LOGIN_TIMEOUT).await;
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
                Duration::from_millis(40)
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
        start_with(&attempts, SessionTool::Claude, program, LOGIN_TIMEOUT).await;
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
        start_with(&attempts, SessionTool::Claude, program, LOGIN_TIMEOUT).await;
        assert_eq!(
            finished(&attempts, SessionTool::Claude).await.state,
            "error"
        );
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
        )
        .await;
        assert_eq!(result.state, "error");
        assert!(!dir.path().join("calls").exists());
    }
}
