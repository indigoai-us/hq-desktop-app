//! Shared test-only infrastructure for env-var-sensitive tests across crate modules.
//! A single mutex serializes tests that mutate process-global env (HQ_STATE_DIR) even
//! when cargo runs them in parallel within the crate test binary.
use std::sync::Mutex;
pub static ENV_MUTEX: Mutex<()> = Mutex::new(());
