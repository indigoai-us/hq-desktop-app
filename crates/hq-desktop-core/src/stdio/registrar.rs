//! Process-registrar seam for [`crate::stdio`] children.

use std::sync::{Arc, OnceLock, RwLock};

/// Seam that lets stdio children join the host app's existing process registry
/// without `hq-desktop-core` taking a dependency on Tauri.
///
/// **Why this exists (no orphan processes).** `apps/sync` already owns a
/// process registry that `terminate_all_for_exit` drains from
/// `RunEvent::ExitRequested`. Rather than inventing a second exit path for
/// agent children — a second path is a second thing to forget — the app
/// installs a registrar that forwards to `commands::process::{register_process,
/// deregister_process}`. Every child process then appears in the one registry
/// that app quit already reaps.
///
/// Implementations must be cheap and non-blocking: they are called from
/// [`crate::stdio::StdioChild::spawn`], [`crate::stdio::StdioChild::shutdown`],
/// and `Drop`.
pub trait StdioProcessRegistrar: Send + Sync {
    /// Record that `handle` now owns OS process `pid`.
    fn register(&self, handle: &str, pid: u32);

    /// Record the Windows Job Object that owns `handle`'s process tree.
    ///
    /// **Why this exists.** On Unix a pid is enough: the child leads its own
    /// process group and the host's exit drain signals the negated pid, taking
    /// the whole tree. Windows has no process groups, so the pid alone lets the
    /// drain terminate the child and *orphan everything it spawned*. The Job
    /// Object handle is the missing half, and it must reach the same registry
    /// entry the drain reads.
    ///
    /// Called at most once per handle, immediately after
    /// [`register`](Self::register) and only on Windows. The implementation
    /// takes ownership: it is responsible for `CloseHandle` in its own
    /// `deregister`.
    ///
    /// Defaulted to a no-op so non-Windows hosts, test fakes, and any
    /// implementation predating this method keep compiling unchanged.
    fn register_job(&self, handle: &str, job: isize) {
        let _ = (handle, job);
    }

    /// Forget `handle` — its process has been reaped or abandoned.
    fn deregister(&self, handle: &str);
}

type RegistrarCell = RwLock<Option<Arc<dyn StdioProcessRegistrar>>>;

static PROCESS_REGISTRAR: OnceLock<RegistrarCell> = OnceLock::new();

fn registrar_cell() -> &'static RegistrarCell {
    PROCESS_REGISTRAR.get_or_init(|| RwLock::new(None))
}

/// Install the process registrar. Last writer wins; installing is idempotent
/// from the app's point of view because the app installs exactly one.
///
/// When no registrar is installed (unit tests, headless tooling) the stdio
/// child still works — it is simply not visible to the host's exit drain, and
/// `Drop`/`shutdown` process-group kill remains the cleanup path.
pub fn set_process_registrar(r: Arc<dyn StdioProcessRegistrar>) {
    if let Ok(mut guard) = registrar_cell().write() {
        *guard = Some(r);
    }
}

/// The installed registrar, if any. Poisoned lock ⇒ `None`: a registry we
/// cannot reach must degrade to "not registered", never panic a spawn.
pub(crate) fn registrar() -> Option<Arc<dyn StdioProcessRegistrar>> {
    registrar_cell().read().ok()?.clone()
}

/// Test-only: uninstall the registrar so a fake does not leak across tests.
#[cfg(test)]
pub(crate) fn clear_process_registrar() {
    if let Ok(mut guard) = registrar_cell().write() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<String>>,
    }

    impl StdioProcessRegistrar for Recorder {
        fn register(&self, handle: &str, pid: u32) {
            self.events
                .lock()
                .unwrap()
                .push(format!("register:{handle}:{pid}"));
        }
        fn deregister(&self, handle: &str) {
            self.events.lock().unwrap().push(format!("deregister:{handle}"));
        }
    }

    #[test]
    fn an_installed_registrar_is_visible_and_clearable() {
        let _guard = crate::stdio::child::test_fakes::registrar_lock();
        let rec = Arc::new(Recorder::default());
        set_process_registrar(rec.clone());

        let installed = registrar().expect("a registrar was just installed");
        installed.register("h-1", 7);
        // The default `register_job` body must be a no-op, not a panic — a
        // non-Windows host never overrides it.
        installed.register_job("h-1", 0);
        installed.deregister("h-1");

        assert_eq!(
            *rec.events.lock().unwrap(),
            vec!["register:h-1:7".to_string(), "deregister:h-1".to_string()]
        );

        clear_process_registrar();
        assert!(
            registrar().is_none(),
            "clearing must leave no registrar behind for the next test"
        );
    }
}
