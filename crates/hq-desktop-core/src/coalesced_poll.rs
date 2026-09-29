//! Serialize poll requests while retaining one trailing run for wakes that
//! arrive during an in-flight poll.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};

/// Coalesces any number of overlapping wake requests into one trailing poll.
/// The pending bit is set before waiting for the lock, so a wake cannot be lost
/// between the current poll finishing and the next caller acquiring the lock.
pub struct CoalescedPoll {
    serial: tokio::sync::Mutex<()>,
    pending: AtomicBool,
}

impl CoalescedPoll {
    pub const fn new() -> Self {
        Self {
            serial: tokio::sync::Mutex::const_new(()),
            pending: AtomicBool::new(false),
        }
    }

    pub async fn run<F, Fut>(&self, mut poll: F)
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = ()>,
    {
        self.pending.store(true, Ordering::Release);
        let _guard = self.serial.lock().await;
        while self.pending.swap(false, Ordering::AcqRel) {
            poll().await;
        }
    }
}

impl Default for CoalescedPoll {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::CoalescedPoll;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Notify;

    #[tokio::test]
    async fn overlapping_wake_runs_one_trailing_poll() {
        let gate = Arc::new(CoalescedPoll::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let queued_wakes = Arc::new(Notify::new());
        let queued_count = Arc::new(AtomicUsize::new(0));

        let first_gate = Arc::clone(&gate);
        let first_calls = Arc::clone(&calls);
        let first_started = Arc::clone(&started);
        let first_release = Arc::clone(&release);
        let first = tokio::spawn(async move {
            first_gate
                .run(|| {
                    let calls = Arc::clone(&first_calls);
                    let started = Arc::clone(&first_started);
                    let release = Arc::clone(&first_release);
                    async move {
                        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                            started.notify_one();
                            release.notified().await;
                        }
                    }
                })
                .await;
        });

        started.notified().await;
        let mut overlapping_wakes = Vec::new();
        for _ in 0..3 {
            let gate = Arc::clone(&gate);
            let calls = Arc::clone(&calls);
            let queued_wakes = Arc::clone(&queued_wakes);
            let queued_count = Arc::clone(&queued_count);
            overlapping_wakes.push(tokio::spawn(async move {
                if queued_count.fetch_add(1, Ordering::SeqCst) == 2 {
                    queued_wakes.notify_one();
                }
                gate.run(|| {
                    let calls = Arc::clone(&calls);
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                    }
                })
                .await;
            }));
        }
        queued_wakes.notified().await;
        release.notify_one();

        first.await.expect("first poll task succeeds");
        for wake in overlapping_wakes {
            wake.await.expect("queued wake task succeeds");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
