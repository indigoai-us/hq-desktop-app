// Shared test infrastructure for env-var-sensitive tests across util and commands modules.
//
// Both `util::journal::tests` and `commands::first_push::tests` mutate HQ_STATE_DIR.
// A single mutex here ensures they serialize even when cargo runs tests in parallel.
// The same guard holds the package-use state lock so a home swap cannot delete the
// directory another test is using to publish an HQ CLI update lease. A publisher
// borrows that lock when the home snapshot is unchanged, so a test can hold this
// guard and still publish from a spawned task.
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use tempfile::TempDir;

pub(crate) struct EnvMutex {
    inner: Mutex<()>,
}

pub(crate) static ENV_MUTEX: EnvMutex = EnvMutex {
    inner: Mutex::new(()),
};

pub(crate) struct EnvGuard<'a> {
    _env: MutexGuard<'a, ()>,
    _lease: hq_desktop_core::package_use_lease::PackageUseStateGuard,
}

pub(crate) struct EnvPoisonError<'a> {
    guard: EnvGuard<'a>,
}

impl<'a> EnvPoisonError<'a> {
    pub(crate) fn into_inner(self) -> EnvGuard<'a> {
        self.guard
    }
}

impl EnvMutex {
    pub(crate) fn lock(&self) -> Result<EnvGuard<'_>, EnvPoisonError<'_>> {
        match self.inner.lock() {
            Ok(env) => Ok(EnvGuard {
                _env: env,
                _lease: hq_desktop_core::package_use_lease::lock_package_use_state(),
            }),
            Err(poisoned) => Err(EnvPoisonError {
                guard: EnvGuard {
                    _env: poisoned.into_inner(),
                    _lease: hq_desktop_core::package_use_lease::lock_package_use_state(),
                },
            }),
        }
    }
}

pub(crate) struct ScopedHome {
    previous: Vec<(&'static str, Option<OsString>)>,
    _lease: hq_desktop_core::package_use_lease::PackageUseStateGuard,
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
    // Lock first, then publish the temporary home, so a lease publisher waits
    // until this guard restores the previous values.
    let lease = hq_desktop_core::package_use_lease::lock_package_use_state();
    let names = ["HOME", "USERPROFILE", "HQ_TEST_HOME"];
    let previous = names
        .into_iter()
        .map(|name| {
            let old = std::env::var_os(name);
            std::env::set_var(name, path);
            (name, old)
        })
        .collect();
    ScopedHome {
        previous,
        _lease: lease,
    }
}

/// Write a healthy managed Git fixture at the same path used by the installer.
#[cfg(not(windows))]
pub(crate) fn write_usable_managed_git(home: &Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let git = home.join("Library/Application Support/Indigo HQ/toolchain/git/bin/git");
    std::fs::create_dir_all(git.parent().expect("managed Git parent")).unwrap();
    std::fs::write(&git, "#!/bin/sh\nprintf 'git version fixture'\n").unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    git
}

pub(crate) fn with_state_dir<F: FnOnce(&Path)>(f: F) {
    let _guard = ENV_MUTEX.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = TempDir::new().unwrap();
    std::env::set_var("HQ_STATE_DIR", tmp.path().to_str().unwrap());
    f(tmp.path());
    std::env::remove_var("HQ_STATE_DIR");
}
