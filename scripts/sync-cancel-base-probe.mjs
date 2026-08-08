#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const run = (program, args, options = {}) =>
  execFileSync(program, args, {
    cwd: repo,
    encoding: "utf8",
    stdio: "inherit",
    timeout: 600_000,
    ...options,
  });

const mergeBase = execFileSync("git", ["-C", repo, "merge-base", "HEAD", "origin/main"], {
  encoding: "utf8",
  timeout: 60_000,
}).trim();
const worktreeRoot = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "sync-cancel-base-"));
const processPath = join(worktreeRoot, "apps", "sync", "src-tauri", "src", "commands", "process.rs");
const mainPath = join(worktreeRoot, "apps", "sync", "src-tauri", "src", "main.rs");
const manifestPath = join(worktreeRoot, "apps", "sync", "src-tauri", "Cargo.toml");
const targetDir = join(repo, "apps", "sync", "src-tauri", "target");
const sidecarNodeModules = join(repo, "apps", "sync", "sidecar", "recall-sdk-bridge", "node_modules");
const baseSidecarNodeModules = join(
  worktreeRoot,
  "apps",
  "sync",
  "sidecar",
  "recall-sdk-bridge",
  "node_modules",
);

const baseProbe = String.raw`
/// CI-only red proof injected into the merge-base artifact. It drives the
/// legacy Windows Job Object cancellation path and confirms that its code-1
/// exit is still classified as a capture before this PR's new decision seam.
///
/// It also pins the base defect the new pid-tree regressions guard, so that
/// regression has its own red half rather than riding on the classifier proof:
/// with no Job Object attached, base's Windows cancellation arm performs no
/// termination at all and still reports success — the child survives its own
/// cancellation. The candidate's pid-tree fallback is therefore genuinely new
/// behaviour that needs its own gate.
///
/// The cross-generation escalation hazard is deliberately NOT probed here. It
/// was fixed on main before this merge base: the SIGKILL escalation resolves
/// through dispatch_signal_checked, which is generation-scoped, so there is no
/// red half to reproduce. The candidate's real-child A/B regression guards that
/// property against a future regression instead of proving a new fix.
pub fn run_sync_cancel_base_probe() -> Result<serde_json::Value, String> {
    let handle = format!("sync-cancel-base-probe-{}", Uuid::new_v4());
    pre_register_handle(&handle);
    let spawn = SpawnArgs {
        cmd: "cmd.exe".to_string(),
        args: vec![
            "/d".to_string(),
            "/c".to_string(),
            "ping 127.0.0.1 -n 30 > nul".to_string(),
        ],
        cwd: None,
        env: None,
    };
    let cancel_handle = handle.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(250));
        let _ = cancel_process_impl(&cancel_handle, Duration::ZERO);
    });

    let mut terminal = None;
    run_process_impl(&handle, &spawn, |event| {
        if let ProcessEvent::Exit { code, signal, .. } = event {
            terminal = Some((code, signal));
        }
    })
    .map_err(|error| format!("base probe runner failed: {error}"))?;

    let (exit_code, signal) = terminal.ok_or_else(|| "base probe saw no exit".to_string())?;
    let decision = if matches!(
        hq_desktop_core::sync_outcome::classify_runner_exit_disposition(
            exit_code, signal, false, false, false,
        ),
        hq_desktop_core::sync_outcome::RunnerExitDisposition::Alert
    ) {
        "capture"
    } else {
        "suppress"
    };

    // Base defect 1: an unattached Job Object leaves cancellation with nothing
    // to terminate, and it still reports success to its caller.
    let unattached_handle = format!("sync-cancel-base-nojob-{}", Uuid::new_v4());
    let mut unattached = Command::new("cmd.exe")
        .args(["/d", "/c", "ping 127.0.0.1 -n 30 > nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("base probe could not spawn the unattached fixture: {error}"))?;
    register_process(&unattached_handle, unattached.id());
    let unattached_cancel_reported = cancel_process_impl(&unattached_handle, Duration::ZERO);
    // Proving an absence needs a settle window; it is bounded and fixed.
    thread::sleep(Duration::from_millis(2000));
    let unattached_terminated = unattached
        .try_wait()
        .map_err(|error| format!("base probe could not probe the unattached fixture: {error}"))?
        .is_some();
    let _ = unattached.kill();
    let _ = unattached.wait();
    deregister_process(&unattached_handle);

    Ok(serde_json::json!({
        "exit_code": exit_code,
        "decision": decision,
        "unattached_cancel_reported": unattached_cancel_reported,
        "unattached_terminated": unattached_terminated,
    }))
}
`;

const baseProbeMain = `    if std::env::args().any(|arg| arg == "--sync-cancel-base-probe") {
        match commands::process::run_sync_cancel_base_probe() {
            Ok(result) => {
                println!("{result}");
                return;
            }
            Err(error) => {
                eprintln!("sync-cancel-base-probe failed: {error}");
                std::process::exit(1);
            }
        }
    }

`;

try {
  run("git", ["-C", repo, "worktree", "add", "--detach", worktreeRoot, mergeBase], {
    timeout: 120_000,
  });
  if (!existsSync(sidecarNodeModules)) {
    throw new Error("the checked-out sidecar dependencies are unavailable for the base-artifact proof");
  }
  // The detached merge-base worktree deliberately has no untracked dependencies.
  // A junction lets its Tauri build use the workflow's already-installed sidecar
  // dependencies without copying them into, or changing, the base source tree.
  symlinkSync(sidecarNodeModules, baseSidecarNodeModules, "junction");
  const processSource = readFileSync(processPath, "utf8");
  const processMarker = "// Tauri commands";
  if (!processSource.includes(processMarker)) {
    throw new Error("base process source has no Tauri-command insertion marker");
  }
  writeFileSync(
    processPath,
    processSource.replace(processMarker, `${baseProbe}\n// Tauri commands`),
    "utf8",
  );

  const mainSource = readFileSync(mainPath, "utf8");
  const mainMarker = "fn main() {";
  if (!mainSource.includes(mainMarker)) {
    throw new Error("base main source has no main-function insertion marker");
  }
  writeFileSync(mainPath, mainSource.replace(mainMarker, `${mainMarker}\n${baseProbeMain}`), "utf8");

  run(
    "cargo",
    [
      "build",
      "--manifest-path",
      manifestPath,
      "--target",
      "x86_64-pc-windows-msvc",
    ],
    { timeout: 600_000, env: { ...process.env, CARGO_TARGET_DIR: targetDir } },
  );
  const artifact = join(targetDir, "x86_64-pc-windows-msvc", "debug", "hq-sync-menubar.exe");
  const output = execFileSync(artifact, ["--sync-cancel-base-probe"], {
    cwd: worktreeRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  const raw = output.trim().split(/\r?\n/).at(-1);
  const probe = JSON.parse(raw);
  // Each expectation below is the DEFECT at base. Every one of them must flip
  // on the candidate, proving the new regressions gate genuinely new behaviour.
  const baseDefects = [
    ["the reported code-1 exit is still captured", probe.exit_code === 1 && probe.decision === "capture"],
    ["an unattached cancellation still reports success", probe.unattached_cancel_reported === true],
    ["an unattached cancellation terminates nothing", probe.unattached_terminated === false],
  ];
  const missing = baseDefects.filter(([, held]) => !held).map(([name]) => name);
  if (missing.length > 0) {
    // After HQ-DESKTOP-48 landed on main, subsequent PRs (including version
    // bumps) share a merge-base that already carries the fixed cancellation
    // path. The historical red defects then do not hold — that is expected,
    // not a regression. Accept only the fully post-fix shape; any mixed
    // partial state still fails so a half-landed base cannot silently pass.
    const alreadyFixed =
      probe.decision === "suppress" &&
      probe.unattached_terminated === true;
    if (alreadyFixed) {
      process.stdout.write(
        `${JSON.stringify({ ...probe, base: mergeBase, already_fixed: true, missing })}
`,
      );
    } else {
      throw new Error(
        `base sync-cancel probe did not reproduce: ${missing.join("; ")} — raw result: ${raw}`,
      );
    }
  } else {
    process.stdout.write(`${JSON.stringify({ ...probe, base: mergeBase })}
`);
  }
} finally {
  try {
    run("git", ["-C", repo, "worktree", "remove", "--force", worktreeRoot], {
      timeout: 120_000,
    });
  } catch (error) {
    process.stderr.write(
      `git worktree cleanup failed; removing the isolated directory directly: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
}
