//! Windows long-path-support detection and enablement.
//!
//! When `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled`
//! is `0`, Win32 file APIs refuse paths over MAX_PATH (260 chars). npm
//! packages with deeply nested dependencies can exceed that limit under HQ's
//! managed toolchain prefix.

#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::process::Command;

#[cfg(windows)]
use winreg::enums::*;
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
const SUBKEY: &str = r"SYSTEM\CurrentControlSet\Control\FileSystem";
#[cfg(windows)]
const VALUE_NAME: &str = "LongPathsEnabled";
#[cfg(windows)]
const ADMIN_REQUIRED_MESSAGE: &str =
    "Enabling Windows long paths requires administrator approval. This step is \
     optional for HQ; ask IT or re-run HQ as an administrator if you want to \
     enable it.";

#[cfg(windows)]
#[derive(Debug, Clone)]
struct ElevatedProcessOutput {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[cfg(windows)]
trait LongPathsRegistry {
    fn read_long_paths_value(&self) -> Result<Option<u32>, String>;
}

#[cfg(windows)]
struct WindowsLongPathsRegistry;

#[cfg(windows)]
impl LongPathsRegistry for WindowsLongPathsRegistry {
    fn read_long_paths_value(&self) -> Result<Option<u32>, String> {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let key = hklm
            .open_subkey(SUBKEY)
            .map_err(|e| format!("HKLM\\{SUBKEY} open failed: {e}"))?;
        match key.get_value::<u32, _>(VALUE_NAME) {
            Ok(value) => Ok(Some(value)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("HKLM\\{SUBKEY}\\{VALUE_NAME} read failed: {e}")),
        }
    }
}

#[cfg(windows)]
trait LongPathsElevator {
    fn run_elevated_powershell(&self, script: &str) -> Result<ElevatedProcessOutput, String>;
}

#[cfg(windows)]
struct PowerShellLongPathsElevator;

#[cfg(windows)]
impl LongPathsElevator for PowerShellLongPathsElevator {
    fn run_elevated_powershell(&self, script: &str) -> Result<ElevatedProcessOutput, String> {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .output()
            .map_err(|e| format!("failed to spawn powershell: {e}"))?;

        Ok(ElevatedProcessOutput {
            success: output.status.success(),
            code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[cfg(windows)]
fn long_paths_value_is_enabled(value: Option<u32>) -> bool {
    value == Some(1)
}

#[cfg(windows)]
fn read_long_paths_enabled(registry: &impl LongPathsRegistry) -> Result<bool, String> {
    registry
        .read_long_paths_value()
        .map(long_paths_value_is_enabled)
}

#[cfg(windows)]
fn is_long_paths_enabled_with(registry: &impl LongPathsRegistry) -> bool {
    match read_long_paths_enabled(registry) {
        Ok(enabled) => enabled,
        Err(e) => {
            eprintln!("[long-paths] {e}");
            false
        }
    }
}

/// Read the current value of `LongPathsEnabled`.
///
/// Returns `false` when the value is `0`, missing, or unreadable, matching the
/// unsafe-default behavior of the OS itself.
#[cfg(windows)]
#[tauri::command]
pub fn is_long_paths_enabled() -> bool {
    is_long_paths_enabled_with(&WindowsLongPathsRegistry)
}

#[cfg(windows)]
fn looks_like_admin_required_failure(output: &str) -> bool {
    let lower = output.to_lowercase();
    [
        "canceled by the user",
        "operation was canceled",
        "requires elevation",
        "access is denied",
        "permission denied",
        "not have permission",
        "administrator",
        "privilege",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

/// Set `LongPathsEnabled = 1` via an elevated PowerShell child.
///
/// Returns `Ok("already_enabled")` if the flag is already set,
/// `Ok("enabled")` after a successful elevated write, or `Err(...)` with a
/// human-readable reason, most commonly the user declining UAC consent.
#[cfg(windows)]
#[tauri::command]
pub fn enable_long_paths() -> Result<String, String> {
    enable_long_paths_with(&WindowsLongPathsRegistry, &PowerShellLongPathsElevator)
}

#[cfg(windows)]
fn enable_long_paths_with(
    registry: &impl LongPathsRegistry,
    elevator: &impl LongPathsElevator,
) -> Result<String, String> {
    if read_long_paths_enabled(registry)? {
        return Ok("already_enabled".to_string());
    }

    let inner = format!(
        "Set-ItemProperty -Path 'HKLM:\\{SUBKEY}' -Name '{VALUE_NAME}' \
         -Value 1 -Type DWord -Force"
    );

    let outer = format!(
        "$ErrorActionPreference = 'Stop'; \
         $p = Start-Process powershell -Verb RunAs -Wait -PassThru \
         -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-Command',\"{inner}\"; \
         exit $p.ExitCode"
    );

    let output = elevator.run_elevated_powershell(&outer)?;

    if output.success {
        if read_long_paths_enabled(registry)? {
            return Ok("enabled".to_string());
        }
        return Err(
            "the elevated registry write reported success but the value did not stick \
             - check that your AD policy is not pinning LongPathsEnabled=0"
                .to_string(),
        );
    }

    if looks_like_admin_required_failure(&output.stdout)
        || looks_like_admin_required_failure(&output.stderr)
    {
        return Err(ADMIN_REQUIRED_MESSAGE.to_string());
    }
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    Err(format!(
        "elevation failed (exit {}): {}",
        output.code.unwrap_or(-1),
        detail
    ))
}

/// Open Windows Settings > System > For Developers.
///
/// That page exposes the long-path toggle on supported Windows 11 builds.
#[cfg(windows)]
#[tauri::command]
pub fn open_long_paths_settings() -> Result<(), String> {
    let status = Command::new("cmd")
        .args(["/c", "start", "", "ms-settings:developers"])
        .status()
        .map_err(|e| format!("failed to spawn cmd: {e}"))?;
    if !status.success() {
        return Err(format!(
            "Settings open failed (exit {})",
            status.code().unwrap_or(-1)
        ));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;

    struct MockRegistry {
        reads: RefCell<VecDeque<Result<Option<u32>, String>>>,
    }

    impl MockRegistry {
        fn new(reads: Vec<Result<Option<u32>, String>>) -> Self {
            Self {
                reads: RefCell::new(VecDeque::from(reads)),
            }
        }
    }

    impl LongPathsRegistry for MockRegistry {
        fn read_long_paths_value(&self) -> Result<Option<u32>, String> {
            self.reads
                .borrow_mut()
                .pop_front()
                .expect("mock registry read was not queued")
        }
    }

    struct MockElevator {
        calls: Cell<usize>,
        result: RefCell<Result<ElevatedProcessOutput, String>>,
        last_script: RefCell<Option<String>>,
    }

    impl MockElevator {
        fn new(result: Result<ElevatedProcessOutput, String>) -> Self {
            Self {
                calls: Cell::new(0),
                result: RefCell::new(result),
                last_script: RefCell::new(None),
            }
        }
    }

    impl LongPathsElevator for MockElevator {
        fn run_elevated_powershell(&self, script: &str) -> Result<ElevatedProcessOutput, String> {
            self.calls.set(self.calls.get() + 1);
            *self.last_script.borrow_mut() = Some(script.to_string());
            self.result.borrow().clone()
        }
    }

    fn process_output(
        success: bool,
        code: Option<i32>,
        stdout: &str,
        stderr: &str,
    ) -> ElevatedProcessOutput {
        ElevatedProcessOutput {
            success,
            code,
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
        }
    }

    #[test]
    fn is_long_paths_enabled_returns_a_bool() {
        let _ = is_long_paths_enabled();
    }

    #[test]
    fn missing_value_reads_as_disabled() {
        let registry = MockRegistry::new(vec![Ok(None)]);
        assert!(!is_long_paths_enabled_with(&registry));
    }

    #[test]
    fn zero_value_reads_as_disabled() {
        let registry = MockRegistry::new(vec![Ok(Some(0))]);
        assert!(!is_long_paths_enabled_with(&registry));
    }

    #[test]
    fn one_value_reads_as_enabled() {
        let registry = MockRegistry::new(vec![Ok(Some(1))]);
        assert!(is_long_paths_enabled_with(&registry));
    }

    #[test]
    fn read_error_is_logged_as_disabled_for_status_command_and_propagated_for_enable() {
        let status_registry = MockRegistry::new(vec![Err("registry read failed".to_string())]);
        assert!(!is_long_paths_enabled_with(&status_registry));

        let enable_registry = MockRegistry::new(vec![Err("registry read failed".to_string())]);
        let elevator = MockElevator::new(Ok(process_output(true, Some(0), "", "")));
        let err = enable_long_paths_with(&enable_registry, &elevator).unwrap_err();
        assert_eq!(err, "registry read failed");
        assert_eq!(elevator.calls.get(), 0);
    }

    #[test]
    fn already_enabled_skips_elevation() {
        let registry = MockRegistry::new(vec![Ok(Some(1))]);
        let elevator = MockElevator::new(Ok(process_output(true, Some(0), "", "")));
        let result = enable_long_paths_with(&registry, &elevator).unwrap();
        assert_eq!(result, "already_enabled");
        assert_eq!(elevator.calls.get(), 0);
    }

    #[test]
    fn uac_declined_returns_admin_required_message() {
        let registry = MockRegistry::new(vec![Ok(Some(0))]);
        let elevator = MockElevator::new(Ok(process_output(
            false,
            Some(1),
            "",
            "Start-Process : The operation was canceled by the user.",
        )));

        let err = enable_long_paths_with(&registry, &elevator).unwrap_err();

        assert_eq!(err, ADMIN_REQUIRED_MESSAGE);
        assert_eq!(elevator.calls.get(), 1);
    }

    #[test]
    fn successful_write_requires_post_write_verification() {
        let registry = MockRegistry::new(vec![Ok(Some(0)), Ok(Some(1))]);
        let elevator = MockElevator::new(Ok(process_output(true, Some(0), "", "")));

        let result = enable_long_paths_with(&registry, &elevator).unwrap();

        assert_eq!(result, "enabled");
        assert_eq!(elevator.calls.get(), 1);
        assert!(elevator
            .last_script
            .borrow()
            .as_deref()
            .unwrap_or_default()
            .contains("Set-ItemProperty"));
    }

    #[test]
    fn post_write_verify_failure_is_reported() {
        let registry = MockRegistry::new(vec![Ok(Some(0)), Ok(Some(0))]);
        let elevator = MockElevator::new(Ok(process_output(true, Some(0), "", "")));

        let err = enable_long_paths_with(&registry, &elevator).unwrap_err();

        assert!(err.contains("value did not stick"), "got: {err}");
        assert_eq!(elevator.calls.get(), 1);
    }

    #[test]
    fn admin_failure_classifier_matches_uac_decline_and_permissions() {
        assert!(looks_like_admin_required_failure(
            "Start-Process : The operation was canceled by the user."
        ));
        assert!(looks_like_admin_required_failure(
            "Set-ItemProperty : Access is denied"
        ));
        assert!(looks_like_admin_required_failure(
            "The requested operation requires elevation."
        ));
    }

    #[test]
    fn admin_failure_classifier_ignores_unrelated_errors() {
        assert!(!looks_like_admin_required_failure(
            "registry value did not stick because policy pinned it"
        ));
    }
}
