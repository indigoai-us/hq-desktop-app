//! Bridge between `hq_desktop_core::stdio` and this app's process registry.
//!
//! **Why (no orphan processes).** Agent CLI children are spawned by
//! `hq-desktop-core`, which deliberately knows nothing about Tauri. Rather than
//! give them their own exit path — a second thing to remember on every future
//! quit-path change — we install a registrar that forwards their
//! register/deregister calls into [`super::process`]'s registry. Those children
//! then appear in the very same `registered_pids()` snapshot that
//! `terminate_all_for_exit` drains from `RunEvent::ExitRequested` in `main.rs`.
//!
//! Net effect: app quit reaps agent processes, and the tree beneath each one
//! (the MCP servers and tool processes it spawned) goes with it — on Unix via
//! the process group the child leads, on Windows via the Job Object
//! `hq-desktop-core` creates at spawn and hands over through
//! [`StdioProcessRegistrar::register_job`].
//!
//! **The Windows half is why `register_job` exists.** `register_process` alone
//! records a bare pid, and the Windows `terminate_pids_for_exit` →
//! `cancel_process_impl` body does nothing at all for an entry whose
//! `job_handle` is `None`. Without the job handle reaching this registry, app
//! quit would not signal a stdio child on Windows at all, and `shutdown`'s
//! `start_kill` fallback would kill it alone, orphaning its children.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use hq_desktop_core::stdio::StdioProcessRegistrar;

/// Forwards stdio child lifecycle events into the app's process registry.
struct ProcessRegistryBridge;

impl StdioProcessRegistrar for ProcessRegistryBridge {
    fn register(&self, handle: &str, pid: u32) {
        // `register_process` inserts the entry when the handle is unknown, so
        // no `pre_register_handle` round-trip is needed here.
        super::process::register_process(handle, pid);
    }

    fn register_job(&self, handle: &str, job: isize) {
        // `register_job_handle` is Windows-only (the registry field it writes
        // is too), so the forward is cfg'd rather than the trait method.
        #[cfg(target_os = "windows")]
        super::process::register_job_handle(handle, job);
        #[cfg(not(target_os = "windows"))]
        let _ = (handle, job);
    }

    fn deregister(&self, handle: &str) {
        super::process::deregister_process(handle);
    }
}

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Install the stdio → process-registry bridge. Idempotent.
pub fn install_stdio_process_registrar() {
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    hq_desktop_core::stdio::set_process_registrar(Arc::new(ProcessRegistryBridge));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_twice_is_a_no_op() {
        install_stdio_process_registrar();
        install_stdio_process_registrar();
        assert!(INSTALLED.load(Ordering::SeqCst));
    }

    #[test]
    fn the_bridge_round_trips_a_handle_through_the_process_registry() {
        // The no-orphan wiring proof: what a stdio child registers is what the
        // app's exit drain would later see and kill.
        let bridge = ProcessRegistryBridge;
        let handle = format!("stdio-bridge-test-{}", uuid::Uuid::new_v4());

        bridge.register(&handle, 424_242);
        assert_eq!(super::super::process::lookup_pid(&handle), Some(424_242));
        assert!(super::super::process::registered_pids()
            .iter()
            .any(|(h, pid)| h == &handle && *pid == 424_242));

        bridge.deregister(&handle);
        assert_eq!(super::super::process::lookup_pid(&handle), None);
    }
}
