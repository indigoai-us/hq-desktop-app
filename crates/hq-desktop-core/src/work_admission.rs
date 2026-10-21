//! Admission latch for the owned personal operation (H8 lifecycle).
//!
//! Sign-out and app quit close this latch before tokens or paths change. While
//! it is closed no new personal operation starts: no install-stage cloud
//! upload, no native first-push, no background safety net, and no
//! personal-projection wrapper call. Operations already running see their
//! ticket go stale at their next check, wrapper children registered here are
//! signalled, and the caller can wait for in-flight work to drain.
//!
//! Scope is deliberately narrow. Company sync, other apps, process leases, and
//! shared runners are not touched here: closing the latch never kills a
//! runner process.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Why admission is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Closed {
    /// Until the next successful sign-in.
    SignedOut,
    /// Permanent for this process.
    Quitting,
}

impl Closed {
    pub fn message(self) -> &'static str {
        match self {
            Closed::SignedOut => "HQ stopped this personal sync work because you signed out.",
            Closed::Quitting => "HQ stopped this personal sync work because the app is quitting.",
        }
    }
}

#[derive(Default)]
struct Inner {
    epoch: u64,
    closed: Option<Closed>,
    in_flight: usize,
    next_cancel_id: u64,
    cancels: Vec<(u64, Arc<AtomicBool>)>,
}

/// The latch. Use [`personal_work`] for the process-wide instance.
pub struct WorkAdmission {
    inner: Mutex<Inner>,
    drained: Condvar,
}

impl Default for WorkAdmission {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkAdmission {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                epoch: 0,
                closed: None,
                in_flight: 0,
                next_cancel_id: 0,
                cancels: Vec::new(),
            }),
            drained: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn is_open(&self) -> bool {
        self.lock().closed.is_none()
    }

    pub fn closed_reason(&self) -> Option<Closed> {
        self.lock().closed
    }

    /// Start one counted operation, or refuse while closed.
    pub fn admit(&'static self) -> Result<Ticket, Closed> {
        let mut inner = self.lock();
        if let Some(reason) = inner.closed {
            return Err(reason);
        }
        inner.in_flight += 1;
        Ok(Ticket {
            gate: self,
            epoch: inner.epoch,
        })
    }

    /// An uncounted marker for long waits (a background watch) that must not
    /// hold up a drain but must notice a close.
    pub fn token(&'static self) -> Option<Token> {
        let inner = self.lock();
        inner.closed.is_none().then_some(Token {
            gate: self,
            epoch: inner.epoch,
        })
    }

    fn current(&self, epoch: u64) -> Result<(), Closed> {
        let inner = self.lock();
        match inner.closed {
            Some(reason) => Err(reason),
            None if inner.epoch != epoch => Err(Closed::SignedOut),
            None => Ok(()),
        }
    }

    /// Close admission and signal every registered child. Quitting is sticky.
    pub fn close(&self, reason: Closed) {
        let mut inner = self.lock();
        if inner.closed != Some(Closed::Quitting) {
            inner.closed = Some(reason);
        }
        inner.epoch += 1;
        for (_, flag) in &inner.cancels {
            flag.store(true, Ordering::Release);
        }
    }

    /// Reopen after a sign-in. Never reopens a quitting process. Work admitted
    /// before the close stays stale: the epoch moved on.
    pub fn reopen_after_sign_in(&self) -> bool {
        let mut inner = self.lock();
        if inner.closed == Some(Closed::SignedOut) {
            inner.closed = None;
            return true;
        }
        false
    }

    /// Wait until every counted operation has finished. True when drained.
    pub fn wait_drained(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut inner = self.lock();
        while inner.in_flight > 0 {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            inner = self
                .drained
                .wait_timeout(inner, deadline - now)
                .map(|(guard, _)| guard)
                .unwrap_or_else(|e| e.into_inner().0);
        }
        true
    }

    pub fn in_flight(&self) -> usize {
        self.lock().in_flight
    }
}

/// One admitted operation. Dropping it ends the operation.
pub struct Ticket {
    gate: &'static WorkAdmission,
    epoch: u64,
}

impl Ticket {
    /// Err once a close happened after this ticket was admitted.
    pub fn check(&self) -> Result<(), Closed> {
        self.gate.current(self.epoch)
    }

    pub fn token(&self) -> Token {
        Token {
            gate: self.gate,
            epoch: self.epoch,
        }
    }

    /// Register a child's cancel flag so a close signals it. A close that
    /// already happened sets the flag at once.
    pub fn register_cancel(&self, flag: Arc<AtomicBool>) -> CancelRegistration {
        let mut inner = self.gate.lock();
        let id = inner.next_cancel_id;
        inner.next_cancel_id += 1;
        if inner.closed.is_some() || inner.epoch != self.epoch {
            flag.store(true, Ordering::Release);
        }
        inner.cancels.push((id, flag));
        CancelRegistration {
            gate: self.gate,
            id,
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut inner = self.gate.lock();
        inner.in_flight = inner.in_flight.saturating_sub(1);
        if inner.in_flight == 0 {
            self.gate.drained.notify_all();
        }
    }
}

/// Uncounted, copyable staleness check.
#[derive(Clone, Copy)]
pub struct Token {
    gate: &'static WorkAdmission,
    epoch: u64,
}

impl Token {
    pub fn check(&self) -> Result<(), Closed> {
        self.gate.current(self.epoch)
    }
}

/// Removes a registered cancel flag on drop.
pub struct CancelRegistration {
    gate: &'static WorkAdmission,
    id: u64,
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        self.gate.lock().cancels.retain(|(id, _)| *id != self.id);
    }
}

static PERSONAL_WORK: WorkAdmission = WorkAdmission::new();

/// The process-wide latch for the owned personal operation.
pub fn personal_work() -> &'static WorkAdmission {
    &PERSONAL_WORK
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate() -> &'static WorkAdmission {
        Box::leak(Box::new(WorkAdmission::new()))
    }

    #[test]
    fn sign_out_refuses_new_work_and_stales_running_work() {
        let gate = gate();
        let running = gate.admit().unwrap();
        let token = gate.token().unwrap();
        assert!(running.check().is_ok());

        gate.close(Closed::SignedOut);
        assert_eq!(gate.admit().err(), Some(Closed::SignedOut));
        assert!(gate.token().is_none());
        assert_eq!(running.check(), Err(Closed::SignedOut));
        assert_eq!(token.check(), Err(Closed::SignedOut));

        // A new sign-in reopens admission, but work from before stays stale.
        assert!(gate.reopen_after_sign_in());
        assert!(gate.admit().is_ok());
        assert_eq!(running.check(), Err(Closed::SignedOut));
    }

    #[test]
    fn quitting_never_reopens() {
        let gate = gate();
        gate.close(Closed::Quitting);
        assert!(!gate.reopen_after_sign_in());
        gate.close(Closed::SignedOut);
        assert_eq!(gate.closed_reason(), Some(Closed::Quitting));
        assert_eq!(gate.admit().err(), Some(Closed::Quitting));
    }

    #[test]
    fn close_signals_registered_children_and_drain_waits_for_them() {
        let gate = gate();
        let ticket = gate.admit().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let registration = ticket.register_cancel(flag.clone());

        assert!(!gate.wait_drained(Duration::from_millis(20)));
        gate.close(Closed::Quitting);
        assert!(flag.load(Ordering::Acquire));

        let worker = std::thread::spawn(move || {
            // The child exits on its flag; only then does the operation end.
            std::thread::sleep(Duration::from_millis(50));
            drop(registration);
            drop(ticket);
        });
        assert!(gate.wait_drained(Duration::from_secs(5)));
        worker.join().unwrap();
        assert_eq!(gate.in_flight(), 0);
    }

    #[test]
    fn a_child_registered_after_the_close_is_cancelled_at_once() {
        let gate = gate();
        let ticket = gate.admit().unwrap();
        gate.close(Closed::SignedOut);
        let flag = Arc::new(AtomicBool::new(false));
        let _registration = ticket.register_cancel(flag.clone());
        assert!(flag.load(Ordering::Acquire));
    }

    #[test]
    fn an_idle_gate_drains_immediately() {
        assert!(gate().wait_drained(Duration::ZERO));
    }
}
