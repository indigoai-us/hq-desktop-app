fn launchd_task_command(args: &[String]) -> Option<(&str, &[String])> {
    if args.get(1).map(String::as_str) != Some("--hq-launchd-task") {
        return None;
    }
    let program = args.get(2)?;
    let is_node = std::path::Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == "node" || name == "node.exe");
    let forwarded = args.get(3..)?;
    (is_node && !forwarded.is_empty()).then(|| (program.as_str(), forwarded))
}

#[cfg(unix)]
static CHILD_PID: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(unix)]
extern "C" fn forward_signal(signal: libc::c_int) {
    let pid = CHILD_PID.load(std::sync::atomic::Ordering::Relaxed);
    if pid > 0 {
        // kill(2) is async-signal-safe and the child remains the attributed task.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

fn run_task(program: &str, args: &[String]) -> ! {
    let mut child = std::process::Command::new(program)
        .args(args)
        .spawn()
        .unwrap_or_else(|error| {
            eprintln!("HQ LaunchAgent could not start its task: {error}");
            std::process::exit(127);
        });
    #[cfg(unix)]
    {
        CHILD_PID.store(child.id() as i32, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGTERM, forward_signal as libc::sighandler_t);
            libc::signal(libc::SIGINT, forward_signal as libc::sighandler_t);
            libc::signal(libc::SIGHUP, forward_signal as libc::sighandler_t);
        }
    }
    let status = child.wait().unwrap_or_else(|error| {
        eprintln!("HQ LaunchAgent could not wait for its task: {error}");
        std::process::exit(1);
    });
    #[cfg(unix)]
    CHILD_PID.store(0, std::sync::atomic::Ordering::Relaxed);
    #[cfg(unix)]
    let exit_code = status.code().unwrap_or_else(|| {
        use std::os::unix::process::ExitStatusExt;
        128 + status.signal().unwrap_or(1)
    });
    #[cfg(not(unix))]
    let exit_code = status.code().unwrap_or(1);
    std::process::exit(exit_code);
}

pub fn run_if_requested() {
    let args: Vec<String> = std::env::args().collect();
    if let Some((program, child_args)) = launchd_task_command(&args) {
        run_task(program, child_args);
    }
}

#[cfg(test)]
mod tests {
    use super::{launchd_task_command, run_task};

    #[test]
    fn recognizes_launcher_protocol_and_forwards_arguments() {
        let args = vec![
            "/Applications/HQ.app/Contents/MacOS/hq-sync-menubar".into(),
            "--hq-launchd-task".into(),
            "/usr/bin/node".into(),
            "/opt/hq/dist/index.js".into(),
            "daemon".into(),
            "run".into(),
        ];
        let (program, forwarded) = launchd_task_command(&args).expect("task invocation");
        assert_eq!(program, "/usr/bin/node");
        assert_eq!(forwarded, ["/opt/hq/dist/index.js", "daemon", "run"]);
    }

    #[test]
    fn ignores_normal_app_launches_and_incomplete_invocations() {
        assert!(launchd_task_command(&["hq-sync-menubar".into()]).is_none());
        assert!(launchd_task_command(&["hq".into(), "--hq-launchd-task".into()]).is_none());
        assert!(launchd_task_command(&[
            "hq".into(),
            "--hq-launchd-task".into(),
            "/bin/sh".into(),
            "-c".into()
        ])
        .is_none());
        assert!(launchd_task_command(&[
            "hq".into(),
            "--hq-launchd-task".into(),
            "/usr/bin/node".into()
        ])
        .is_none());
    }

    #[cfg(unix)]
    #[test]
    fn signal_helper_child() {
        if std::env::var_os("HQ_LAUNCHD_SIGNAL_HELPER").is_some() {
            let marker = std::env::var("HQ_LAUNCHD_SIGNAL_MARKER").expect("marker path");
            run_task("/bin/sh", &["-c".into(), format!("trap 'echo term > {marker}; exit 23' TERM; echo ready > {marker}.ready; while :; do sleep 0.05; done")]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn forwards_sigterm_to_child_and_exits_with_child_status() {
        use std::{
            fs,
            process::Command,
            thread,
            time::{Duration, Instant},
        };
        let marker = std::env::temp_dir().join(format!("hq-launchd-signal-{}", std::process::id()));
        let _ = fs::remove_file(&marker);
        let _ = fs::remove_file(format!("{}.ready", marker.display()));
        let mut launcher = Command::new(std::env::current_exe().expect("test executable"))
            .args([
                "--exact",
                "launchd_task::tests::signal_helper_child",
                "--nocapture",
            ])
            .env("HQ_LAUNCHD_SIGNAL_HELPER", "1")
            .env("HQ_LAUNCHD_SIGNAL_MARKER", &marker)
            .spawn()
            .expect("spawn launcher helper");
        let ready = format!("{}.ready", marker.display());
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::path::Path::new(&ready).exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(std::path::Path::new(&ready).exists(), "child did not start");
        unsafe {
            libc::kill(launcher.id() as i32, libc::SIGTERM);
        }
        let status = launcher.wait().expect("wait for launcher");
        assert_eq!(status.code(), Some(23));
        assert!(fs::read_to_string(&marker)
            .expect("child signal marker")
            .contains("term"));
        let _ = fs::remove_file(marker);
        let _ = fs::remove_file(ready);
    }
}
