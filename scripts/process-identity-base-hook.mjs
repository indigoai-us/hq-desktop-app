import fs from "node:fs";
import path from "node:path";

const baseDir = process.argv[2];
if (!baseDir) {
  throw new Error("usage: process-identity-base-hook.mjs <base-worktree>");
}

const processPath = path.join(baseDir, "apps/sync/src-tauri/src/commands/process.rs");
const mainPath = path.join(baseDir, "apps/sync/src-tauri/src/main.rs");

function insertBefore(filePath, marker, insertion) {
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(insertion.trim())) {
    throw new Error(`${filePath} already contains the base probe hook`);
  }
  const offset = source.indexOf(marker);
  if (offset === -1) {
    throw new Error(`expected insertion marker missing from ${filePath}`);
  }
  fs.writeFileSync(filePath, `${source.slice(0, offset)}${insertion}\n${source.slice(offset)}`);
}

insertBefore(
  processPath,
  "// ─────────────────────────────────────────────────────────────────────────────\n// App-exit teardown",
  `
/// Test-only hook injected into the exact base worktree by the macOS artifact
/// job. It exercises the original production registry and cancellation code
/// through the real menubar executable, then reports the expected wrong-owner
/// signal-9 outcome as JSON.
#[cfg(unix)]
pub fn run_process_identity_base_probe() -> Result<String, String> {
    use std::time::Instant;

    const HANDLE: &str = "process-identity-base-probe";
    const DEADLINE: Duration = Duration::from_secs(5);

    fn spawn_term_ignoring_fixture() -> Result<std::process::Child, String> {
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        put_in_own_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("spawn TERM-ignoring fixture: {error}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "fixture stdout pipe was unavailable".to_string())?;
        let mut ready = String::new();
        BufReader::new(stdout)
            .read_line(&mut ready)
            .map_err(|error| format!("read fixture readiness: {error}"))?;
        if ready != "ready\\n" {
            terminate(&mut child);
            return Err("fixture did not confirm TERM handler readiness".to_string());
        }
        Ok(child)
    }

    fn terminate(child: &mut std::process::Child) {
        let _ = signal::kill(Pid::from_raw(-(child.id() as i32)), Signal::SIGKILL);
        let _ = child.wait();
    }

    fn wait_for_exit(child: &mut std::process::Child) -> Result<ExitStatus, String> {
        let started = Instant::now();
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("observe fixture exit: {error}"))?
            {
                return Ok(status);
            }
            if started.elapsed() >= DEADLINE {
                return Err("fixture did not exit within base-probe deadline".to_string());
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn alive(pid: u32) -> bool {
        signal::kill(Pid::from_raw(pid as i32), None).is_ok()
    }

    pre_register_handle(HANDLE);
    let mut child_a = spawn_term_ignoring_fixture()?;
    register_process(HANDLE, child_a.id());
    deregister_process(HANDLE);

    pre_register_handle(HANDLE);
    let mut child_b = match spawn_term_ignoring_fixture() {
        Ok(child) => child,
        Err(error) => {
            terminate(&mut child_a);
            return Err(error);
        }
    };
    register_process(HANDLE, child_b.id());

    // The base resolves this stale deferred action by public handle only, so
    // this deliberately marks and kills B rather than the still-live A.
    let stale_executed = cancel_process_impl(HANDLE, Duration::ZERO);
    let replacement_status = match wait_for_exit(&mut child_b) {
        Ok(status) => status,
        Err(error) => {
            terminate(&mut child_a);
            terminate(&mut child_b);
            return Err(error);
        }
    };
    let actor_alive = alive(child_a.id());
    terminate(&mut child_a);

    let replacement_signal = exit_signal(&replacement_status);
    if !stale_executed || replacement_signal != Some(Signal::SIGKILL as i32) || !actor_alive {
        return Err("base probe did not reproduce the stale-handle wrong-owner kill".to_string());
    }
    Ok(serde_json::json!({
        "schema_version": "hq-sync.process-identity-base-probe.v1",
        "stale_executed": stale_executed,
        "replacement_signal": replacement_signal,
        "actor_alive": actor_alive
    })
    .to_string())
}
`
);

insertBefore(
  mainPath,
  "fn main() {",
  `
#[cfg(unix)]
fn run_process_identity_base_probe_if_requested() -> bool {
    if !std::env::args()
        .skip(1)
        .any(|arg| arg == "--process-identity-base-probe")
    {
        return false;
    }
    match commands::process::run_process_identity_base_probe() {
        Ok(transcript) => {
            println!("{transcript}");
            // The exact base is supposed to demonstrate the bug, so make this
            // a failing probe after emitting its machine-readable transcript.
            std::process::exit(1);
        }
        Err(error) => {
            eprintln!("process-identity base probe failed: {error}");
            std::process::exit(1);
        }
    }
    true
}

#[cfg(not(unix))]
fn run_process_identity_base_probe_if_requested() -> bool {
    false
}

`
);

const mainSource = fs.readFileSync(mainPath, "utf8");
const mainMarker = "fn main() {\n";
if (!mainSource.includes(mainMarker)) {
  throw new Error("base main function marker disappeared while injecting probe dispatch");
}
fs.writeFileSync(
  mainPath,
  mainSource.replace(mainMarker, `${mainMarker}    if run_process_identity_base_probe_if_requested() {\n        return;\n    }\n\n`)
);
