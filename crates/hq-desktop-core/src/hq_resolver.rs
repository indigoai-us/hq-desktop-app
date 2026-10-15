//! Self-healing resolver for the `hq` CLI subprocess invocation.
//!
//! ## Why this exists
//!
//! AppBar shells out to `hq` from these paths:
//!   * `commands::run_cli_provision` — Phase B's `hq cloud provision company`
//!   * `commands::first_push` — Option C3's `hq sync push --creds-from-stdin --json`
//!   * `commands::hq_anywhere` — global install/uninstall for Claude Code and Codex
//!
//! The existing commands depend on flags that arrived in
//! `@indigoai-us/hq-cli@5.7.0` (the C3 push flags) and earlier versions
//! (`cloud provision company` in 5.6.0, `--skip-initial-sync` in 5.6.1). The
//! Path A demote-to-local flow shells out to
//! `hq cloud demote company <slug> --force`, which arrived in
//! `@indigoai-us/hq-cli@5.10.0`. If the user's installed `hq` binary is
//! missing or on a stale PATH, the subprocess fails with a cryptic spawn or
//! unknown-option error. HQ Anywhere has a separate resolver because its
//! optional global-runtime commands require hq-cli 5.345.46 and must not
//! change the CLI floor for the shared workflows.
//!
//! ## What it does
//!
//! Runs capability probes against the local `hq` once per AppBar process:
//! `hq sync push --help` must contain `--creds-from-stdin`, and
//! `hq cloud --help` must list the `demote` subcommand.
//! If both probes pass, the local binary is used directly (fast path).
//! Otherwise we fall back to:
//!
//! ```text
//! npx -y --package=@indigoai-us/hq-cli@<HQ_CLI_NPM_RANGE> hq <args>
//! ```
//!
//! Same pattern as `commands::sync::HQ_CLOUD_VERSION`'s npx pin for
//! `hq-sync-runner`, just lazily probed instead of hardcoded — the local
//! binary stays the fast path when present and current.
//!
//! ## Why a capability probe, not `hq --version`
//!
//! `repos/public/hq/packages/hq-cli/src/index.ts` carries a hardcoded
//! `.version("5.5.0")` string that has not been kept in sync with the npm
//! package version (verified against published `hq-cli@5.7.0`). Probing
//! `hq --version` would lie to us. Asking "do the flags I need exist?"
//! is the only reliable signal.
//!
//! ## Lifecycle
//!
//! Cached in a process-wide slot. If the user later upgrades hq-cli
//! (`npm install -g @indigoai-us/hq-cli@latest`), the next AppBar restart
//! re-probes and picks up the local binary again.
//!
//! During first-run setup (see [`set_first_run_setup_active`]) an npx
//! fallback is never cached. On a fresh machine `hq` is missing only because
//! the managed install has not finished yet; caching npx at that point would
//! pin every later call in the process to a slow npm download.
//! [`invalidate_hq_resolution`] drops the cached choice after the managed
//! install lands, and [`resolve_hq_for_setup`] lets setup-time callers wait
//! for that install instead of shelling out to npx.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use crate::cli_update_lock::{
    acquire_cli_update_lock_waiting_cancellable,
    acquire_cli_update_lock_waiting_cancellable_in, CliUpdateLockGuard, CliUpdateLockWaitAttempt,
    CLI_INSTALL_LOCK_WAIT_BACKOFF, CLI_INSTALL_LOCK_WAIT_BUDGET,
};
use crate::logfile::log;
use crate::paths;

/// npm range used for shared CLI workflows requiring the 5.10-era commands.
pub const HQ_CLI_NPM_RANGE: &str = "^5.10.0";

/// New global runtime commands are optional to shared CLI workflows and use
/// their own fallback floor when HQ Anywhere needs them.
pub const HQ_CLI_GLOBAL_RUNTIME_NPM_RANGE: &str = "^5.345.46";

/// Tool name written into the shared cli-update lock while an npx self-heal
/// run holds it, so whoever finds the lock can name the holder.
pub const NPX_RUN_LOCK_TOOL: &str = "hq-desktop-app-npx-run";

/// Cached invocation decision for the current process. `None` until the
/// first cacheable probe, and again after [`invalidate_hq_resolution`].
static HQ_INVOCATION: RwLock<Option<HqInvocation>> = RwLock::new(None);

/// True while first-run setup is in progress. The app's lifecycle state
/// machine sets it; [`resolve_hq`] reads it to decide whether an npx fallback
/// may be cached.
static FIRST_RUN_SETUP_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Mark whether first-run setup is in progress. The app calls this whenever
/// its lifecycle state changes: true for the install states, false once the
/// lifecycle reaches SteadyState.
pub fn set_first_run_setup_active(active: bool) {
    FIRST_RUN_SETUP_ACTIVE.store(active, Ordering::SeqCst);
}

/// Whether first-run setup is currently in progress.
pub fn first_run_setup_active() -> bool {
    FIRST_RUN_SETUP_ACTIVE.load(Ordering::SeqCst)
}

/// Drop the cached invocation so the next [`resolve_hq`] re-probes. Called
/// after the managed hq-cli install succeeds.
pub fn invalidate_hq_resolution() {
    match HQ_INVOCATION.write() {
        Ok(mut slot) => *slot = None,
        Err(poisoned) => *poisoned.into_inner() = None,
    }
    log("hq-resolver", "cached invocation cleared; next call re-probes");
}

/// Whether a probe result may be cached for the rest of the process. The npx
/// fallbacks are not cached while first-run setup is active, because the
/// managed install is expected to provide a local `hq` shortly.
fn should_cache(invocation: &HqInvocation, first_run_active: bool) -> bool {
    match invocation {
        HqInvocation::Local(_) => true,
        HqInvocation::Npx | HqInvocation::NpxGlobalRuntime => !first_run_active,
    }
}

fn cached_invocation() -> Option<HqInvocation> {
    match HQ_INVOCATION.read() {
        Ok(slot) => slot.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn store_invocation(invocation: &HqInvocation) {
    match HQ_INVOCATION.write() {
        Ok(mut slot) => *slot = Some(invocation.clone()),
        Err(poisoned) => *poisoned.into_inner() = Some(invocation.clone()),
    }
}

/// Serializes concurrent `npx --package=…` self-heal runs. Two npx installs
/// racing the shared `~/.npm/_npx/<hash>/` install dir stomp each other's
/// half-written package — surfacing as EEXIST / ENOTEMPTY rename failures or a
/// cacache integrity error. Only the Npx path takes it; the resolved-local
/// fast-path needs no serialization (HQ-SYNC-6).
static NPX_SERIAL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn npx_serial_lock() -> &'static tokio::sync::Mutex<()> {
    NPX_SERIAL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// How to spawn `hq` for the current AppBar process.
#[derive(Debug, Clone)]
pub enum HqInvocation {
    /// Local `hq` at this absolute path passed every capability probe.
    Local(String),
    /// Local `hq` was missing or too old; route through `npx -y --package=...@<range> hq`.
    Npx,
    /// HQ Anywhere needs the newer global-runtime commands; use the pinned
    /// package without changing the shared CLI fallback floor.
    NpxGlobalRuntime,
}

impl HqInvocation {
    /// Build a `tokio::process::Command` for `hq <args>` according to the
    /// chosen invocation strategy. Caller appends args via `cmd.arg(...)`
    /// after this returns.
    pub fn command(&self) -> tokio::process::Command {
        match self {
            HqInvocation::Local(path) => paths::tokio_spawn_command(path, &[]),
            HqInvocation::Npx => {
                let npx = paths::resolve_bin("npx");
                let mut cmd = paths::tokio_spawn_command(&npx, &[]);
                cmd.args([
                    "-y",
                    "--package",
                    &format!("@indigoai-us/hq-cli@{HQ_CLI_NPM_RANGE}"),
                    "hq",
                ]);
                cmd
            }
            HqInvocation::NpxGlobalRuntime => {
                let npx = paths::resolve_bin("npx");
                let mut cmd = paths::tokio_spawn_command(&npx, &[]);
                cmd.args([
                    "-y",
                    "--package",
                    &format!("@indigoai-us/hq-cli@{HQ_CLI_GLOBAL_RUNTIME_NPM_RANGE}"),
                    "hq",
                ]);
                cmd
            }
        }
    }

    /// Human-readable label for log lines and diagnostic output.
    pub fn label(&self) -> String {
        match self {
            HqInvocation::Local(path) => format!("local:{path}"),
            HqInvocation::Npx => format!("npx:@indigoai-us/hq-cli@{HQ_CLI_NPM_RANGE}"),
            HqInvocation::NpxGlobalRuntime => {
                format!("npx:@indigoai-us/hq-cli@{HQ_CLI_GLOBAL_RUNTIME_NPM_RANGE}")
            }
        }
    }

    /// Closed-cardinality invocation tag for telemetry. The human-readable
    /// label above may contain a user's absolute path and is log-only.
    pub fn telemetry_kind(&self) -> &'static str {
        match self {
            HqInvocation::Local(_) => "local",
            HqInvocation::Npx | HqInvocation::NpxGlobalRuntime => "npx",
        }
    }

    /// Path-free label for captured spawn messages. Keep the useful package
    /// range for npx while replacing a local absolute path with its kind.
    pub fn sentry_label(&self) -> String {
        match self {
            HqInvocation::Local(_) => self.telemetry_kind().to_string(),
            HqInvocation::Npx | HqInvocation::NpxGlobalRuntime => self.label(),
        }
    }

    /// Acquire the locks an npx self-heal run must hold until its subprocess
    /// has completed. Returns `Ok(None)` for a resolved local binary (which
    /// needs no serialization; many can run in parallel).
    ///
    /// For the npx variants it takes the process-wide serial lock, so
    /// concurrent `npx --package=…` installs can't race the shared
    /// `~/.npm/_npx/` cache (HQ-SYNC-6), and then the cross-process
    /// cli-update lock, so the run cannot overlap a managed CLI install or
    /// either auto-updater. A lock still held after the wait budget is
    /// logged and returned as `Err`.
    pub async fn npx_serial_guard(&self) -> Result<Option<NpxRunGuard>, String> {
        self.npx_serial_guard_with(None, CLI_INSTALL_LOCK_WAIT_BUDGET, CLI_INSTALL_LOCK_WAIT_BACKOFF)
            .await
    }

    /// `lock_dir` overrides the lock directory (tests); `None` uses the
    /// production resolution (`HQ_LOCK_DIR`, else `~/.hq/locks`).
    async fn npx_serial_guard_with(
        &self,
        lock_dir: Option<std::path::PathBuf>,
        budget: Duration,
        backoff: Duration,
    ) -> Result<Option<NpxRunGuard>, String> {
        if matches!(self, HqInvocation::Local(_)) {
            return Ok(None);
        }
        let serial = npx_serial_lock().lock().await;
        let version = env!("CARGO_PKG_VERSION");
        let attempt = tokio::task::spawn_blocking(move || {
            let on_wait = |holder: &str| {
                log(
                    "hq-resolver",
                    &format!("npx run waiting for the cli-update lock held by {holder}"),
                )
            };
            match lock_dir {
                Some(dir) => acquire_cli_update_lock_waiting_cancellable_in(
                    &dir,
                    NPX_RUN_LOCK_TOOL,
                    version,
                    budget,
                    backoff,
                    || false,
                    on_wait,
                ),
                None => acquire_cli_update_lock_waiting_cancellable(
                    NPX_RUN_LOCK_TOOL,
                    version,
                    budget,
                    backoff,
                    || false,
                    on_wait,
                ),
            }
        })
        .await
        .map_err(|e| {
            let msg = format!("npx run could not wait for the cli-update lock: {e}");
            log("hq-resolver", &msg);
            msg
        })??;
        match attempt {
            CliUpdateLockWaitAttempt::Acquired(guard) => Ok(Some(NpxRunGuard {
                _cli_update_lock: guard,
                _serial: serial,
            })),
            CliUpdateLockWaitAttempt::Held { holder } => {
                let msg = format!(
                    "another hq-cli install is still running ({holder}); \
                     skipped the npx run so the two installs do not collide"
                );
                log("hq-resolver", &msg);
                Err(msg)
            }
            CliUpdateLockWaitAttempt::Cancelled => {
                let msg = "npx run lock wait was cancelled".to_string();
                log("hq-resolver", &msg);
                Err(msg)
            }
        }
    }
}

/// Held for the whole duration of an npx self-heal run: the in-process serial
/// lock plus the cross-process cli-update lock
/// (indigo-serialize-concurrent-npx-self-heal-shellouts). Fields drop in
/// declaration order, so the file lock is released before the serial lock.
#[derive(Debug)]
pub struct NpxRunGuard {
    _cli_update_lock: CliUpdateLockGuard,
    _serial: tokio::sync::MutexGuard<'static, ()>,
}

/// Outcome of [`resolve_hq_for_setup`].
#[derive(Debug, Clone)]
pub enum HqResolution {
    /// A usable invocation. During setup this is always a local binary.
    Ready(HqInvocation),
    /// First-run setup is active and no capable local `hq` exists yet. The
    /// caller should wait for the managed install instead of using npx.
    AwaitingManagedInstall,
}

/// Resolve the right way to invoke `hq`, caching the decision per-process.
/// Probes local CLI capabilities synchronously the first time; subsequent
/// calls return the cached value with no overhead. An npx fallback is
/// returned but not cached while first-run setup is active.
///
/// Logs the chosen invocation under the `hq-resolver` tag so a stuck
/// subprocess leaves a breadcrumb of which binary path it tried.
pub fn resolve_hq() -> HqInvocation {
    if let Some(cached) = cached_invocation() {
        return cached;
    }
    let chosen = probe();
    let label = chosen.label();
    let cacheable = should_cache(&chosen, first_run_setup_active());
    if cacheable {
        store_invocation(&chosen);
        log("hq-resolver", &format!("chose invocation: {label}"));
    } else {
        log(
            "hq-resolver",
            &format!("chose invocation: {label} (not cached during first-run setup)"),
        );
    }
    // Breadcrumb for any subsequent Sentry event in the same scope —
    // tells us at-a-glance whether the user was on the locally-installed
    // CLI or the npx self-heal path. Critical when triaging
    // provision-cli failures: a stale local `hq` and a missing `npx`
    // produce different stderr signatures.
    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some("hq-resolver".to_string()),
        message: Some(format!("chose invocation: {label}")),
        level: sentry::Level::Info,
        ..Default::default()
    });
    chosen
}

/// Setup-aware resolve. While first-run setup is active, an npx result means
/// the managed install has not landed yet, so this returns
/// [`HqResolution::AwaitingManagedInstall`] instead of the npx fallback.
pub fn resolve_hq_for_setup() -> HqResolution {
    setup_resolution(resolve_hq(), first_run_setup_active())
}

fn setup_resolution(invocation: HqInvocation, first_run_active: bool) -> HqResolution {
    match invocation {
        HqInvocation::Npx | HqInvocation::NpxGlobalRuntime if first_run_active => {
            HqResolution::AwaitingManagedInstall
        }
        other => HqResolution::Ready(other),
    }
}

fn probe() -> HqInvocation {
    let local = paths::resolve_bin("hq");
    // resolve_bin returns the bare "hq" string when it can't find the
    // binary anywhere — that's our signal to skip the probe entirely
    // and fall straight to npx. Avoids spawning a process that's
    // guaranteed to ENOENT.
    if local == "hq" {
        log(
            "hq-resolver",
            "local `hq` not found by resolve_bin; falling back to npx",
        );
        return HqInvocation::Npx;
    }

    let (creds_ok, demote_ok) = (
        capability_probe_creds_from_stdin(&local),
        capability_probe_cloud_demote(&local),
    );
    let selected = select_shared_invocation(local.clone(), creds_ok, demote_ok);
    if matches!(&selected, HqInvocation::Local(_)) {
        selected
    } else {
        let mut missing = Vec::new();
        if !creds_ok {
            missing.push("--creds-from-stdin");
        }
        if !demote_ok {
            missing.push("`cloud demote` subcommand");
        }
        log(
            "hq-resolver",
            &format!(
                "local `hq` at {local} failed capability probe (missing {}); \
                 falling back to npx. Hint: `npm install -g @indigoai-us/hq-cli@latest` to upgrade.",
                missing.join(", "),
            ),
        );
        selected
    }
}

fn shared_cli_capabilities_supported(creds_ok: bool, demote_ok: bool) -> bool {
    creds_ok && demote_ok
}

fn select_shared_invocation(local: String, creds_ok: bool, demote_ok: bool) -> HqInvocation {
    if shared_cli_capabilities_supported(creds_ok, demote_ok) {
        HqInvocation::Local(local)
    } else {
        HqInvocation::Npx
    }
}

/// Resolve HQ Anywhere's newer runtime commands without raising the minimum
/// CLI version for the shared install and sync workflows.
pub fn resolve_hq_for_global_runtime() -> HqInvocation {
    let shared = resolve_hq();
    let global_runtime_supported = match &shared {
        HqInvocation::Local(path) => capability_probe_global_runtime_install(path),
        HqInvocation::Npx | HqInvocation::NpxGlobalRuntime => false,
    };
    select_global_runtime_invocation(shared, global_runtime_supported)
}

/// Error-message prefix a caller returns when it declines to run `hq` because
/// first-run setup has not finished installing it. The renderer matches on it
/// to show a still-setting-up state instead of a raw error.
pub const SETUP_PENDING_CODE: &str = "setup_pending";

/// Setup-aware [`resolve_hq_for_global_runtime`]. While first-run setup is
/// active, an npx result means the managed install has not landed yet, so this
/// returns [`HqResolution::AwaitingManagedInstall`] and the caller skips the
/// npx download.
pub fn resolve_hq_for_global_runtime_during_setup() -> HqResolution {
    setup_resolution(resolve_hq_for_global_runtime(), first_run_setup_active())
}

/// The error string for a run declined by [`SETUP_PENDING_CODE`].
pub fn setup_pending_error(what: &str) -> String {
    format!("{SETUP_PENDING_CODE}: {what} waits for HQ setup to finish installing hq")
}

fn select_global_runtime_invocation(
    shared: HqInvocation,
    global_runtime_supported: bool,
) -> HqInvocation {
    match shared {
        local @ HqInvocation::Local(_) if global_runtime_supported => local,
        _ => HqInvocation::NpxGlobalRuntime,
    }
}

/// Common subprocess wrapper for capability probes. Spawns `bin <args>`,
/// returns stdout on success, `None` on spawn-error or non-zero exit.
/// Shared between the probes so a future probe addition is one helper call.
fn run_help(bin: &str, args: &[&str]) -> Option<String> {
    let mut cmd = paths::spawn_command(bin, args);
    let output = cmd
        // Inherit PATH from parent so node-shebanged `hq` can find `node`.
        .env("PATH", paths::child_path())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// True iff the local `hq` at `bin` supports the C3 subprocess contract.
/// Probes `hq sync push --help` and looks for `--creds-from-stdin` in
/// stdout — shipped in `@indigoai-us/hq-cli@5.7.0`.
///
/// Capability-based check is more reliable than parsing `hq --version`
/// because index.ts has a stale hardcoded version string that lies about
/// the actual installed capabilities.
///
/// ~100-300ms cold cost (one-time per AppBar startup).
fn capability_probe_creds_from_stdin(bin: &str) -> bool {
    run_help(bin, &["sync", "push", "--help"])
        .map(|s| s.contains("--creds-from-stdin"))
        .unwrap_or(false)
}

/// True iff the local `hq` at `bin` supports `cloud demote company`,
/// shipped in `@indigoai-us/hq-cli@5.10.0`. Probes `hq cloud --help` and
/// looks for the literal `demote` subcommand line.
///
/// Required because `--creds-from-stdin` alone is a 5.7-era capability —
/// a 5.7–5.9 local binary passes the C3 probe but lacks the demote
/// subcommand AppBar's Path A relies on. Without this probe, those
/// users would silently get `error: unknown command 'demote'` instead
/// of the npx self-heal.
fn capability_probe_cloud_demote(bin: &str) -> bool {
    run_help(bin, &["cloud", "--help"])
        .map(|s| s.contains("demote"))
        .unwrap_or(false)
}

/// True iff local install and uninstall commands both support the global
/// runtime options used by HQ Anywhere. These options require hq-cli 5.345.46.
fn capability_probe_global_runtime_install(bin: &str) -> bool {
    let install_help = run_help(bin, &["install", "--help"]);
    let uninstall_help = run_help(bin, &["uninstall", "--help"]);
    match (install_help, uninstall_help) {
        (Some(install), Some(uninstall)) => {
            global_runtime_install_help_supported(&install, &uninstall)
        }
        _ => false,
    }
}

fn global_runtime_install_help_supported(install_help: &str, uninstall_help: &str) -> bool {
    [install_help, uninstall_help]
        .iter()
        .all(|help| help.contains("--global") && help.contains("--runtime"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bin path that doesn't exist must produce a `false` result for every
    /// capability probe (not a panic or hang). This is the primary
    /// `Local → Npx` fallback trigger and we lock the contract here.
    #[test]
    fn capability_probes_reject_nonexistent_binary() {
        let bogus = "/nonexistent/path/to/hq-binary-xyz-123";
        assert!(!capability_probe_creds_from_stdin(bogus));
        assert!(!capability_probe_cloud_demote(bogus));
        assert!(!capability_probe_global_runtime_install(bogus));
    }

    #[test]
    fn global_runtime_install_probe_requires_install_and_uninstall_options() {
        let install = "Usage: hq install [options]\n--global --runtime <runtime>";
        let uninstall = "Usage: hq uninstall [options]\n--global --runtime <runtime>";
        assert!(global_runtime_install_help_supported(install, uninstall));
        assert!(!global_runtime_install_help_supported(
            install,
            "Usage: hq uninstall\n--global"
        ));
        assert!(!global_runtime_install_help_supported(
            "Usage: hq install\n--runtime",
            uninstall
        ));
    }

    #[test]
    fn shared_resolver_accepts_existing_cli_capabilities_without_global_install() {
        let local = "/managed/toolchain/hq".to_string();
        assert!(!global_runtime_install_help_supported(
            "Usage: hq install [options]",
            "Usage: hq uninstall [options]",
        ));
        assert!(shared_cli_capabilities_supported(true, true));
        assert!(matches!(
            select_shared_invocation(local.clone(), true, true),
            HqInvocation::Local(path) if path == local
        ));
    }

    #[test]
    fn global_runtime_resolver_uses_its_dedicated_npx_pin_when_local_cli_lacks_global_options() {
        assert!(matches!(
            select_global_runtime_invocation(
                HqInvocation::Local("/managed/toolchain/hq".to_string()),
                false,
            ),
            HqInvocation::NpxGlobalRuntime
        ));

        let cmd = HqInvocation::NpxGlobalRuntime.command();
        let std_cmd = cmd.as_std();
        let args: Vec<&str> = std_cmd
            .get_args()
            .map(|arg| arg.to_str().unwrap_or(""))
            .collect();
        assert_eq!(args[0], "-y");
        assert_eq!(args[1], "--package");
        assert_eq!(
            args[2],
            format!("@indigoai-us/hq-cli@{HQ_CLI_GLOBAL_RUNTIME_NPM_RANGE}")
        );
        assert_eq!(args[3], "hq");
    }

    /// The Npx invocation must build the exact npx argv shape the
    /// existing `hq-sync-runner` pin uses (`-y --package=PKG@RANGE BIN`).
    /// If this drifts, the spawned subprocess won't find `hq`.
    #[test]
    fn npx_invocation_builds_correct_argv() {
        let invocation = HqInvocation::Npx;
        let cmd = invocation.command();
        let std_cmd = cmd.as_std();
        let expected_program = paths::resolve_bin("npx");
        assert_eq!(
            std_cmd.get_program(),
            std::ffi::OsStr::new(&expected_program)
        );
        let args: Vec<&str> = std_cmd
            .get_args()
            .map(|a| a.to_str().unwrap_or(""))
            .collect();
        assert_eq!(args[0], "-y");
        assert_eq!(args[1], "--package");
        assert!(
            args[2].starts_with("@indigoai-us/hq-cli@"),
            "package arg must start with @indigoai-us/hq-cli@; got {}",
            args[2],
        );
        assert!(
            args[2].contains(HQ_CLI_NPM_RANGE),
            "package arg must contain the pinned range {HQ_CLI_NPM_RANGE}; got {}",
            args[2],
        );
        assert_eq!(args[3], "hq");
    }

    /// The Local invocation must use the absolute path verbatim (no
    /// extra args). Caller appends sync/push/--creds-from-stdin/etc.
    #[test]
    fn local_invocation_uses_path_directly() {
        let invocation = HqInvocation::Local("/usr/local/bin/hq".to_string());
        let cmd = invocation.command();
        let std_cmd = cmd.as_std();
        assert_eq!(std_cmd.get_program(), "/usr/local/bin/hq");
        assert_eq!(std_cmd.get_args().count(), 0);
    }

    /// Labels must be human-readable for the logfile breadcrumb.
    #[test]
    fn label_contains_useful_info() {
        let local = HqInvocation::Local("/opt/homebrew/bin/hq".to_string());
        assert!(local.label().contains("/opt/homebrew/bin/hq"));
        assert_eq!(local.telemetry_kind(), "local");
        assert_eq!(local.sentry_label(), "local");
        let npx = HqInvocation::Npx;
        assert!(npx.label().contains("npx"));
        assert!(npx.label().contains("@indigoai-us/hq-cli"));
        assert_eq!(npx.telemetry_kind(), "npx");
        assert_eq!(npx.sentry_label(), npx.label());
    }

    // HQ-SYNC-6: npx self-heal runs must serialize (they share the ~/.npm/_npx
    // cache); resolved-local runs must NOT (they can run in parallel).
    //
    // US-004: the npx run also holds the cross-process cli-update lock. Both
    // lock assertions live in this one test because the serial lock is a
    // process-wide static. The lock dir is a temp dir passed explicitly, so
    // the test never touches process env or the real ~/.hq/locks.
    #[tokio::test]
    async fn npx_serializes_and_holds_cli_update_lock_but_local_does_not() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let lock_file = tmp
            .path()
            .join(crate::cli_update_lock::CLI_UPDATE_LOCK_FILE);

        // Local never takes either lock.
        let local = HqInvocation::Local("/usr/local/bin/hq".to_string());
        assert!(local.npx_serial_guard().await.expect("local").is_none());
        assert!(!lock_file.exists(), "local must not write the cli-update lock");

        // Npx takes both locks, and while held both are contended.
        let guard = HqInvocation::Npx
            .npx_serial_guard_with(Some(tmp.path().to_path_buf()), Duration::from_secs(1), Duration::ZERO)
            .await
            .expect("npx guard");
        assert!(guard.is_some(), "Npx must take the serial lock");
        assert!(
            npx_serial_lock().try_lock().is_err(),
            "the npx lock must be held while a guard is alive"
        );
        let contents = std::fs::read_to_string(&lock_file).expect("cli-update lock written");
        assert!(
            contents.contains(NPX_RUN_LOCK_TOOL),
            "lock must name the npx run as holder; got {contents}"
        );

        // A concurrent Local acquire is unaffected by the held npx lock.
        assert!(local.npx_serial_guard().await.expect("local").is_none());

        // Once the guard drops, both locks are free.
        drop(guard);
        assert!(
            npx_serial_lock().try_lock().is_ok(),
            "the npx lock must be free after the guard drops"
        );
        assert!(!lock_file.exists(), "the cli-update lock must be released");

        // A fresh lock held by another live process (this test's own pid
        // stands in for a running installer) makes the npx run fail with a
        // logged error instead of running alongside it.
        let held = crate::cli_update_lock::acquire_cli_update_lock_in(
            tmp.path(),
            "hq-desktop-app-cli-update",
            "1.2.3",
        )
        .expect("acquire");
        let blocked = HqInvocation::NpxGlobalRuntime
            .npx_serial_guard_with(Some(tmp.path().to_path_buf()), Duration::from_secs(1), Duration::ZERO)
            .await;
        let err = blocked.expect_err("held lock must block the npx run");
        assert!(err.contains("another hq-cli install is still running"), "{err}");
        assert!(
            npx_serial_lock().try_lock().is_ok(),
            "a failed acquire must not leave the serial lock held"
        );
        drop(held);
    }

    #[test]
    fn npx_fallback_is_not_cached_during_first_run_setup() {
        let local = HqInvocation::Local("/managed/toolchain/hq".to_string());
        assert!(should_cache(&local, true));
        assert!(should_cache(&local, false));
        assert!(!should_cache(&HqInvocation::Npx, true));
        assert!(!should_cache(&HqInvocation::NpxGlobalRuntime, true));
        assert!(should_cache(&HqInvocation::Npx, false));
        assert!(should_cache(&HqInvocation::NpxGlobalRuntime, false));
    }

    #[test]
    fn setup_resolution_waits_for_managed_install_instead_of_npx() {
        assert!(matches!(
            setup_resolution(HqInvocation::Npx, true),
            HqResolution::AwaitingManagedInstall
        ));
        assert!(matches!(
            setup_resolution(HqInvocation::NpxGlobalRuntime, true),
            HqResolution::AwaitingManagedInstall
        ));
        assert!(matches!(
            setup_resolution(HqInvocation::Npx, false),
            HqResolution::Ready(HqInvocation::Npx)
        ));
        assert!(matches!(
            setup_resolution(HqInvocation::Local("/x/hq".to_string()), true),
            HqResolution::Ready(HqInvocation::Local(_))
        ));
    }

    #[test]
    fn global_runtime_during_setup_never_falls_back_to_npx() {
        // An old local hq without global-runtime support selects the npx
        // runtime; during setup that must become a wait, not a download.
        let selected = select_global_runtime_invocation(HqInvocation::Local("/x/hq".into()), false);
        assert!(matches!(
            setup_resolution(selected.clone(), true),
            HqResolution::AwaitingManagedInstall
        ));
        assert!(matches!(
            setup_resolution(selected, false),
            HqResolution::Ready(HqInvocation::NpxGlobalRuntime)
        ));
        let capable = select_global_runtime_invocation(HqInvocation::Local("/x/hq".into()), true);
        assert!(matches!(
            setup_resolution(capable, true),
            HqResolution::Ready(HqInvocation::Local(_))
        ));
    }

    #[test]
    fn setup_pending_error_starts_with_code() {
        assert!(setup_pending_error("HQ Anywhere").starts_with("setup_pending: "));
    }

    #[test]
    fn invalidate_clears_cached_invocation() {
        store_invocation(&HqInvocation::Local("/cached/hq".to_string()));
        assert!(matches!(cached_invocation(), Some(HqInvocation::Local(p)) if p == "/cached/hq"));
        invalidate_hq_resolution();
        assert!(cached_invocation().is_none());
    }

    #[test]
    fn first_run_flag_round_trips() {
        let before = first_run_setup_active();
        set_first_run_setup_active(true);
        assert!(first_run_setup_active());
        set_first_run_setup_active(false);
        assert!(!first_run_setup_active());
        set_first_run_setup_active(before);
    }
}
