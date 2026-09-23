use super::*;
use std::io::Write;
use std::sync::mpsc::{self, SyncSender};
use std::time::Instant;

const FIXTURE_MODE: &str = "HQ_SYNC_OUTPUT_BACKPRESSURE_FIXTURE";
const FIXTURE_COMPLETION_PATH: &str = "HQ_SYNC_OUTPUT_BACKPRESSURE_COMPLETION";
const READY_MARKER: &str = "HQ_SYNC_OUTPUT_BACKPRESSURE_READY";
const CHILD_LINES: usize = 2_048;
const CHILD_LINE_BYTES: usize = 8 * 1024;
const CALLBACK_WAIT: Duration = Duration::from_secs(5);
const FIXTURE_RELEASE_TIMEOUT: Duration = Duration::from_secs(15);

struct ReleaseOnDrop(SyncSender<()>);

impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

#[test]
fn reader_backpressures_child_when_callback_is_paused() {
    if std::env::var_os(FIXTURE_MODE).is_some() {
        write_child_fixture();
        return;
    }

    let temp_dir = tempfile::tempdir().expect("create per-test fixture directory");
    let completion_path = temp_dir.path().join("child-complete");
    let executable = std::env::current_exe().expect("resolve test executable");
    let test_module = module_path!();
    let crate_prefix = format!("{}::", env!("CARGO_CRATE_NAME"));
    let test_module = test_module
        .strip_prefix(&crate_prefix)
        .unwrap_or(test_module);
    let child_test = format!("{test_module}::reader_backpressures_child_when_callback_is_paused");
    let mut child_env = std::collections::HashMap::new();
    child_env.insert(FIXTURE_MODE.to_string(), "1".to_string());
    child_env.insert(
        FIXTURE_COMPLETION_PATH.to_string(),
        completion_path.to_string_lossy().into_owned(),
    );

    let spawn = SpawnArgs {
        cmd: executable.to_string_lossy().into_owned(),
        args: vec!["--exact".to_string(), child_test, "--nocapture".to_string()],
        cwd: None,
        env: Some(child_env),
    };
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let release_guard = ReleaseOnDrop(release_tx);
    let handle = format!("output-backpressure-{}", Uuid::new_v4());
    let runner = thread::spawn(move || {
        run_process_impl(&handle, &spawn, |event| {
            if let ProcessEvent::Stdout(line) = event {
                if line.trim() == READY_MARKER {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(FIXTURE_RELEASE_TIMEOUT);
                }
            }
        })
    });

    let callback_entered = entered_rx.recv_timeout(Duration::from_secs(15)).is_ok();
    let completion_preceded_release =
        callback_entered && wait_for_file(&completion_path, CALLBACK_WAIT);

    let _ = release_guard.0.send(());
    let runner_result = runner.join();
    drop(release_guard);

    assert!(
        callback_entered,
        "child output did not reach the paused callback"
    );
    assert!(
        !completion_preceded_release,
        "child completed while the event callback was paused; output was buffered without backpressure"
    );
    assert!(runner_result.is_ok(), "process runner thread panicked");
    runner_result
        .expect("process runner thread panicked")
        .expect("run child through the production process runner");
    assert!(
        completion_path.exists(),
        "child did not finish after the callback resumed"
    );
}

fn wait_for_file(path: &std::path::Path, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if path.exists() {
            return true;
        }
        thread::sleep(Duration::from_millis(10));
    }
    path.exists()
}

fn write_child_fixture() {
    let completion_path = std::env::var_os(FIXTURE_COMPLETION_PATH)
        .expect("child fixture completion path is set by its parent");
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(format!("\n{READY_MARKER}\n").as_bytes())
        .expect("write fixture readiness marker");
    stdout.flush().expect("flush fixture readiness marker");

    let line = vec![b'x'; CHILD_LINE_BYTES];
    for _ in 0..CHILD_LINES {
        stdout.write_all(&line).expect("write fixture output line");
        stdout
            .write_all(b"\n")
            .expect("terminate fixture output line");
    }
    stdout.flush().expect("flush fixture output");
    std::fs::write(completion_path, b"complete").expect("write fixture completion marker");
}
