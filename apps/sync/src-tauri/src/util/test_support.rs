// Shared test infrastructure for env-var-sensitive tests across util and commands modules.
//
// Both `util::journal::tests` and `commands::first_push::tests` mutate HQ_STATE_DIR.
// A single mutex here ensures they serialize even when cargo runs tests in parallel.
use std::ffi::OsString;
use std::path::Path;
use std::sync::Mutex;
use tempfile::TempDir;

pub(crate) static ENV_MUTEX: Mutex<()> = Mutex::new(());

pub(crate) struct ScopedHome {
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl Drop for ScopedHome {
    fn drop(&mut self) {
        for (name, value) in self.previous.drain(..) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// Point every supported home-directory convention at a temporary test home.
/// `dirs::home_dir()` uses USERPROFILE on Windows and HOME on Unix.
pub(crate) fn scoped_home(path: &Path) -> ScopedHome {
    let names = ["HOME", "USERPROFILE", "HQ_TEST_HOME"];
    let previous = names
        .into_iter()
        .map(|name| {
            let old = std::env::var_os(name);
            std::env::set_var(name, path);
            (name, old)
        })
        .collect();
    ScopedHome { previous }
}

pub(crate) fn with_state_dir<F: FnOnce(&Path)>(f: F) {
    let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().unwrap();
    std::env::set_var("HQ_STATE_DIR", tmp.path().to_str().unwrap());
    f(tmp.path());
    std::env::remove_var("HQ_STATE_DIR");
}
