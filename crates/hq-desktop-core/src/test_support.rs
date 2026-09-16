//! Shared test-only infrastructure for env-var-sensitive tests across crate modules.
//! A single mutex serializes tests that mutate process-global env (HQ_STATE_DIR) even
//! when cargo runs them in parallel within the crate test binary.
use std::sync::Mutex;
pub static ENV_MUTEX: Mutex<()> = Mutex::new(());

/// Restores one process-global environment variable when a test exits, including
/// when its assertion panics. Tests that change HOME or PATH must hold
/// [`ENV_MUTEX`] for the whole scope.
pub struct ScopedEnv {
    name: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl ScopedEnv {
    pub fn set(name: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for ScopedEnv {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}
