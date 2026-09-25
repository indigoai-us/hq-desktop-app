//! Runtime app-version resolution for the prebuilt-shell release pipeline
//! (see `apps/sync/scripts/stamp-version.mjs` and `docs/RELEASE.md`
//! "Prebuilt shell").
//!
//! The compiled shell is built once and reused across releases, so the
//! release version is not known at compile time — `env!("APP_VERSION")`
//! (itself sourced from `package.json` by `build.rs`, see `client_info.rs`)
//! would report the shell's *build-time* version, not the version actually
//! being shipped in a given release. `stamp-version.mjs` writes a
//! `version.txt` file into the app bundle's Resources directory at *assemble*
//! time, after the cached shell is downloaded and before signing.
//! `resolve_app_version()` is the single place that reads it back.
//!
//! Resolution order:
//! 1. `HQ_APP_VERSION` env var — escape hatch for tests/dev, and for any
//!    build environment that cannot place a resources file.
//! 2. `<resources_dir>/version.txt`, first line, trimmed — the stamped
//!    release version.
//! 3. `env!("APP_VERSION")` (compile-time) — dev builds run via
//!    `tauri dev`/`cargo run` that never go through the assemble step.
//!
//! Every one of the compile-time-const version usages this replaces
//! (`client_info::CLIENT_VERSION`, the two `env!("CARGO_PKG_VERSION")` call
//! sites in `commands/compat.rs`, and the installer-version field in
//! `commands/telemetry.rs`) must call this instead so the reported version is
//! the assembled release version, not the shell's compile-time version. See
//! the PR description for which call sites are migrated in this change and
//! which are left for a follow-up.

use std::path::Path;
use std::sync::OnceLock;

// This crate has no build.rs of its own (see `client_info.rs`'s
// `set_client_version` for the same pattern), so the compile-time fallback
// (`env!("APP_VERSION")`, emitted by `apps/sync/src-tauri/build.rs`) is
// passed in by the binary rather than baked in here.
fn resolve_uncached(resources_dir: Option<&Path>, compile_time_fallback: &str) -> String {
    if let Ok(v) = std::env::var("HQ_APP_VERSION") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(dir) = resources_dir {
        if let Ok(contents) = std::fs::read_to_string(dir.join("version.txt")) {
            let first_line = contents.lines().next().unwrap_or("").trim();
            if !first_line.is_empty() {
                return first_line.to_string();
            }
        }
    }
    compile_time_fallback.to_string()
}

/// Best-effort resource-dir guess from the running executable's own path, for
/// use at startup before a Tauri `AppHandle` (and its resource resolver)
/// exists. macOS bundles put resources at `<App>.app/Contents/Resources`
/// relative to `Contents/MacOS/<exe>`; Windows/NSIS installs place resources
/// next to the exe. Returns `None` if `current_exe()` fails (never fatal —
/// callers fall through to the env var / compile-time constant).
pub fn resources_dir_from_current_exe() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    if cfg!(target_os = "macos") {
        // Contents/MacOS/<exe> -> Contents/Resources
        exe_dir.parent().map(|contents| contents.join("Resources"))
    } else {
        Some(exe_dir.to_path_buf())
    }
}

static RESOLVED: OnceLock<String> = OnceLock::new();

/// Resolve the running app's version once per process and cache it.
/// `resources_dir` should be the Tauri resource resolver's directory
/// (`app_handle.path().resource_dir()`); pass `None` when no app handle is
/// available yet (falls through to env var / compile-time constant only).
/// `compile_time_fallback` should be `env!("APP_VERSION")` from the binary
/// crate that does have the build.rs-emitted env var.
pub fn resolve_app_version(resources_dir: Option<&Path>, compile_time_fallback: &str) -> &'static str {
    RESOLVED
        .get_or_init(|| resolve_uncached(resources_dir, compile_time_fallback))
        .as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // env::set_var is process-global; serialize the tests that touch it.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const FALLBACK: &str = "0.0.0-fallback";

    #[test]
    fn falls_back_to_compile_time_constant_with_no_env_or_file() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("HQ_APP_VERSION");
        assert_eq!(resolve_uncached(None, FALLBACK), FALLBACK);
    }

    #[test]
    fn env_var_wins_over_everything() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::set_var("HQ_APP_VERSION", "9.9.9-test");
        let dir = std::env::temp_dir();
        assert_eq!(resolve_uncached(Some(&dir), FALLBACK), "9.9.9-test");
        std::env::remove_var("HQ_APP_VERSION");
    }

    #[test]
    fn reads_stamped_version_txt_when_no_env_var() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("HQ_APP_VERSION");
        let dir = std::env::temp_dir().join(format!("hq-runtime-version-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("version.txt"), "1.2.3\n").unwrap();
        assert_eq!(resolve_uncached(Some(&dir), FALLBACK), "1.2.3");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn blank_version_file_falls_back_to_compile_time_constant() {
        let _guard = ENV_LOCK.lock().unwrap();
        std::env::remove_var("HQ_APP_VERSION");
        let dir = std::env::temp_dir().join(format!("hq-runtime-version-test-blank-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("version.txt"), "\n").unwrap();
        assert_eq!(resolve_uncached(Some(&dir), FALLBACK), FALLBACK);
        std::fs::remove_dir_all(&dir).ok();
    }
}
