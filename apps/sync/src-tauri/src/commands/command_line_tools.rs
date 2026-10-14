//! Apple Command Line Tools (CLT) gate for first-run setup.
//!
//! On a fresh Mac, `/usr/bin/git` is a shim. Running it with no CLT installed
//! pops Apple's "install the command line developer tools" dialog and blocks
//! the caller, which stalled first-run setup with nothing on screen. Setup now
//! checks for the tools BEFORE anything shells out to git, shows its own
//! waiting card, and only then asks macOS to install them.
//!
//! Detection never runs the git shim. It uses `xcode-select -p` (exit status
//! plus the printed directory existing) and falls back to the CLT git binary
//! on disk.
//!
//! The Apple installer is the helper app
//! `/System/Library/CoreServices/Install Command Line Developer Tools.app`
//! (bundle id `com.apple.dt.CommandLineTools.installondemand`, process name
//! `Install Command Line Developer Tools`, verified on macOS 26.4 with
//! `plutil -p .../Info.plist`). Its license window opens behind other apps, so
//! setup brings it to the front with `open -b <bundle id>`, which only
//! activates the already-running helper and needs no Automation permission.
//!
//! Test harness: `HQ_FAKE_CLT_MISSING=1` reports the tools missing forever;
//! `HQ_FAKE_CLT_MISSING=/some/marker` reports them missing until that file
//! exists. In fake mode `xcode-select --install` is never run.
//! `HQ_XCODE_SELECT_PATH` swaps the xcode-select binary (unit tests).

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};

pub const INSTALLER_BUNDLE_ID: &str = "com.apple.dt.CommandLineTools.installondemand";
pub const INSTALLER_PROCESS_NAME: &str = "Install Command Line Developer Tools";
pub const FAKE_MISSING_ENV: &str = "HQ_FAKE_CLT_MISSING";
pub const XCODE_SELECT_ENV: &str = "HQ_XCODE_SELECT_PATH";
pub const DEFAULT_XCODE_SELECT: &str = "/usr/bin/xcode-select";
pub const CLT_GIT_PATH: &str = "/Library/Developer/CommandLineTools/usr/bin/git";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CltStatus {
    /// True only on macOS, where git depends on the tools.
    pub required: bool,
    pub present: bool,
    /// Apple's installer helper is running.
    pub installer_open: bool,
    /// The fake-missing harness is active; no real installer is involved.
    pub simulated: bool,
}

/// Side effects the detection needs, injectable for tests.
pub trait CltShell {
    fn env(&self, key: &str) -> Option<String>;
    /// Run `<xcode_select> -p`; Some(stdout) on exit 0.
    fn xcode_select_print_path(&self, xcode_select: &str) -> Option<String>;
    fn path_exists(&self, path: &str) -> bool;
    fn installer_running(&self) -> bool;
}

pub struct RealShell;

impl CltShell for RealShell {
    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    fn xcode_select_print_path(&self, xcode_select: &str) -> Option<String> {
        let out = Command::new(xcode_select)
            .arg("-p")
            .stdin(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn path_exists(&self, path: &str) -> bool {
        Path::new(path).exists()
    }

    fn installer_running(&self) -> bool {
        Command::new("/usr/bin/pgrep")
            .args(["-x", INSTALLER_PROCESS_NAME])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

/// Fake-missing harness state, if the env var is set to something non-empty.
/// Returns Some(still_missing).
fn fake_missing(shell: &dyn CltShell) -> Option<bool> {
    let value = shell.env(FAKE_MISSING_ENV)?;
    let value = value.trim();
    if value.is_empty() || value == "0" {
        return None;
    }
    if value == "1" || value.eq_ignore_ascii_case("true") {
        return Some(true);
    }
    // Treat any other value as a marker path: missing until it exists.
    Some(!shell.path_exists(value))
}

/// True when the tools are installed. Never runs the git shim.
pub fn tools_present(shell: &dyn CltShell) -> bool {
    if let Some(missing) = fake_missing(shell) {
        return !missing;
    }
    let xcode_select = shell
        .env(XCODE_SELECT_ENV)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_XCODE_SELECT.to_string());
    match shell.xcode_select_print_path(&xcode_select) {
        Some(dir) if !dir.is_empty() && shell.path_exists(&dir) => true,
        // xcode-select can be missing or point at a deleted Xcode; the CLT
        // git on disk is a second, independent signal.
        _ => shell.path_exists(CLT_GIT_PATH),
    }
}

pub fn detect(shell: &dyn CltShell, is_macos: bool) -> CltStatus {
    let simulated = fake_missing(shell).is_some();
    if !is_macos && !simulated {
        return CltStatus {
            required: false,
            present: true,
            installer_open: false,
            simulated: false,
        };
    }
    let present = tools_present(shell);
    CltStatus {
        required: true,
        present,
        installer_open: !simulated && !present && shell.installer_running(),
        simulated,
    }
}

/// True when `git` resolves to the macOS shim and the tools are missing, so
/// running it would pop Apple's dialog. Callers must not spawn git then.
pub fn git_would_prompt(shell: &dyn CltShell, is_macos: bool, git: &str) -> bool {
    let status = detect(shell, is_macos);
    status.required && !status.present && (git == "/usr/bin/git" || git == "git")
}

fn bring_installer_front(shell: &dyn CltShell) -> bool {
    if !shell.installer_running() {
        return false;
    }
    // `open -b` on a running app only activates it.
    Command::new("/usr/bin/open")
        .args(["-b", INSTALLER_BUNDLE_ID])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn start_install_blocking() -> CltStatus {
    let shell = RealShell;
    let status = detect(&shell, cfg!(target_os = "macos"));
    if status.simulated || !status.required || status.present {
        return status;
    }
    if !status.installer_open {
        match Command::new("/usr/bin/xcode-select")
            .arg("--install")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(s) => crate::util::logfile::log("clt", &format!("xcode-select --install exit={:?}", s.code())),
            Err(e) => crate::util::logfile::log("clt", &format!("xcode-select --install spawn failed: {e}")),
        }
    }
    let _ = bring_installer_front(&shell);
    detect(&shell, cfg!(target_os = "macos"))
}

/// Status when a blocking probe could not run at all: report missing so the
/// UI keeps waiting and polling rather than running git.
fn unknown_status() -> CltStatus {
    CltStatus {
        required: cfg!(target_os = "macos"),
        present: !cfg!(target_os = "macos"),
        installer_open: false,
        simulated: false,
    }
}

// The commands spawn processes, so they run off the IPC thread.

#[tauri::command]
pub async fn command_line_tools_status() -> CltStatus {
    tauri::async_runtime::spawn_blocking(|| detect(&RealShell, cfg!(target_os = "macos")))
        .await
        .unwrap_or_else(|_| unknown_status())
}

/// Ask macOS to install the tools. The UI calls this only after its waiting
/// card is on screen. Returns the fresh status.
#[tauri::command]
pub async fn command_line_tools_start_install() -> CltStatus {
    tauri::async_runtime::spawn_blocking(start_install_blocking)
        .await
        .unwrap_or_else(|_| unknown_status())
}

/// Bring Apple's installer window to the front. False when it is not open.
#[tauri::command]
pub async fn command_line_tools_show_installer() -> bool {
    tauri::async_runtime::spawn_blocking(|| bring_installer_front(&RealShell))
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    struct FakeShell {
        env: HashMap<String, String>,
        xcode_select: HashMap<String, Option<String>>,
        paths: HashSet<String>,
        installer: bool,
        installer_checks: Cell<u32>,
    }

    impl CltShell for FakeShell {
        fn env(&self, key: &str) -> Option<String> {
            self.env.get(key).cloned()
        }
        fn xcode_select_print_path(&self, xcode_select: &str) -> Option<String> {
            self.xcode_select.get(xcode_select).cloned().flatten()
        }
        fn path_exists(&self, path: &str) -> bool {
            self.paths.contains(path)
        }
        fn installer_running(&self) -> bool {
            self.installer_checks.set(self.installer_checks.get() + 1);
            self.installer
        }
    }

    fn with_xcode(dir: Option<&str>) -> FakeShell {
        let mut shell = FakeShell::default();
        shell
            .xcode_select
            .insert(DEFAULT_XCODE_SELECT.into(), dir.map(str::to_string));
        if let Some(d) = dir {
            shell.paths.insert(d.into());
        }
        shell
    }

    #[test]
    fn present_when_xcode_select_points_at_existing_dir() {
        let shell = with_xcode(Some("/Library/Developer/CommandLineTools"));
        assert!(tools_present(&shell));
        let status = detect(&shell, true);
        assert!(status.required && status.present && !status.installer_open);
    }

    #[test]
    fn missing_when_xcode_select_fails_and_no_clt_git() {
        let shell = with_xcode(None);
        assert!(!tools_present(&shell));
        assert!(!detect(&shell, true).present);
    }

    #[test]
    fn missing_when_xcode_select_points_at_deleted_dir() {
        let mut shell = FakeShell::default();
        shell
            .xcode_select
            .insert(DEFAULT_XCODE_SELECT.into(), Some("/Applications/Gone.app".into()));
        assert!(!tools_present(&shell));
    }

    #[test]
    fn clt_git_on_disk_counts_as_present() {
        let mut shell = with_xcode(None);
        shell.paths.insert(CLT_GIT_PATH.into());
        assert!(tools_present(&shell));
    }

    #[test]
    fn xcode_select_path_override_is_honoured() {
        let mut shell = FakeShell::default();
        shell.env.insert(XCODE_SELECT_ENV.into(), "/tmp/fake-xcode-select".into());
        shell
            .xcode_select
            .insert("/tmp/fake-xcode-select".into(), Some("/tmp/clt".into()));
        shell.paths.insert("/tmp/clt".into());
        assert!(tools_present(&shell));
    }

    #[test]
    fn not_required_off_macos() {
        let shell = with_xcode(None);
        let status = detect(&shell, false);
        assert!(!status.required && status.present);
        assert_eq!(shell.installer_checks.get(), 0);
    }

    #[test]
    fn installer_open_reported_only_while_missing() {
        let mut shell = with_xcode(None);
        shell.installer = true;
        assert!(detect(&shell, true).installer_open);
        let mut ready = with_xcode(Some("/Library/Developer/CommandLineTools"));
        ready.installer = true;
        assert!(!detect(&ready, true).installer_open);
    }

    #[test]
    fn fake_missing_forever_overrides_real_tools() {
        let mut shell = with_xcode(Some("/Library/Developer/CommandLineTools"));
        shell.env.insert(FAKE_MISSING_ENV.into(), "1".into());
        shell.installer = true;
        let status = detect(&shell, true);
        assert!(status.simulated && status.required && !status.present);
        assert!(!status.installer_open, "fake mode never reports the real installer");
    }

    #[test]
    fn fake_missing_marker_resolves_when_file_appears() {
        let mut shell = with_xcode(Some("/Library/Developer/CommandLineTools"));
        shell.env.insert(FAKE_MISSING_ENV.into(), "/tmp/clt-ready".into());
        assert!(!detect(&shell, true).present);
        shell.paths.insert("/tmp/clt-ready".into());
        assert!(detect(&shell, true).present);
    }

    #[test]
    fn fake_missing_applies_off_macos_for_harness_runs() {
        let mut shell = FakeShell::default();
        shell.env.insert(FAKE_MISSING_ENV.into(), "1".into());
        assert!(detect(&shell, false).required);
    }

    #[test]
    fn fake_missing_zero_or_empty_is_off() {
        for v in ["0", "", "  "] {
            let mut shell = with_xcode(Some("/x"));
            shell.env.insert(FAKE_MISSING_ENV.into(), v.into());
            assert!(!detect(&shell, true).simulated, "value {v:?}");
        }
    }

    #[test]
    fn git_would_prompt_only_for_shim_when_missing() {
        let missing = with_xcode(None);
        assert!(git_would_prompt(&missing, true, "/usr/bin/git"));
        assert!(!git_would_prompt(
            &missing,
            true,
            "/Users/x/Library/Application Support/Indigo HQ/toolchain/git/bin/git"
        ));
        let present = with_xcode(Some("/Library/Developer/CommandLineTools"));
        assert!(!git_would_prompt(&present, true, "/usr/bin/git"));
        assert!(!git_would_prompt(&missing, false, "/usr/bin/git"));
    }
}
