// ─────────────────────────────────────────────────────────────────────────────
// ATTRIBUTION
//
// Local file: crates/hq-desktop-core/src/stdio/circuit.rs
//
// This file is derived from `block/buzz`, file `crates/buzz-acp/src/lib.rs`
// (the `SlotCircuit` / `CrashVerdict` section, upstream lines 1007-1140), at
// commit `c5c4f39`.
//
//   Upstream: https://github.com/block/buzz
//   License:  Apache License, Version 2.0
//
// Changes from upstream: made the type and its methods `pub` so the supervisor
// and tests outside this module can drive it; added deterministic-time
// `*_at(now)` variants so breaker open / half-open behaviour is testable
// without sleeping through a 300s cooldown; added `recent_crashes()` for status
// reporting. No behavioural change to the state machine itself.
//
// See the repo-root NOTICE for the full attribution.
// ─────────────────────────────────────────────────────────────────────────────

//! Per-slot crash circuit breaker.
//!
//! An adapter that crashes on startup will crash on *every* restart. Without a
//! breaker the supervisor turns that into a spin loop: spawn, die, spawn, die,
//! burning a core and filling the log. The breaker converts a flapping slot
//! into a quiet, observable `CircuitOpen` state after 3 crashes in 60s, holds
//! it there for a 5-minute cooldown, then allows exactly one half-open probe.
//!
//! All state transitions go through methods on [`SlotCircuit`] — callers never
//! touch `crash_times` or `open_until` directly.

use std::time::{Duration, Instant};

/// Maximum crashes in a [`CIRCUIT_BREAKER_WINDOW`] before a slot's circuit opens.
pub const CIRCUIT_BREAKER_THRESHOLD: usize = 3;
/// Window for circuit-breaker crash counting.
pub const CIRCUIT_BREAKER_WINDOW: Duration = Duration::from_secs(60);
/// Cooldown before a tripped circuit breaker allows a probe respawn.
pub const CIRCUIT_BREAKER_COOLDOWN: Duration = Duration::from_secs(300); // 5 minutes
/// Base backoff delay for respawn (doubles per recent crash, capped).
pub const RESPAWN_BASE_DELAY: Duration = Duration::from_secs(1);
/// Maximum respawn backoff delay.
pub const RESPAWN_MAX_DELAY: Duration = Duration::from_secs(30);

/// Result of [`SlotCircuit::record_crash`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrashVerdict {
    /// Respawn is allowed after sleeping for this duration (jittered backoff).
    Respawn(Duration),
    /// Circuit is open — do not respawn.
    CircuitOpen,
    /// Circuit was open but the cooldown has elapsed — one probe respawn is
    /// allowed (no backoff sleep). If the probe crashes, the next
    /// [`record_crash`](SlotCircuit::record_crash) re-opens the circuit
    /// immediately.
    HalfOpenProbe,
}

/// Per-slot circuit breaker state.
///
/// `crash_times` holds timestamps of recent crashes within
/// [`CIRCUIT_BREAKER_WINDOW`]. `open_until` is set when the threshold is hit;
/// the circuit stays open until that instant, then allows one probe respawn
/// (half-open). If the probe crashes, the circuit re-opens for another
/// [`CIRCUIT_BREAKER_COOLDOWN`].
///
/// Upstream also carries a `respawn_in_flight` latch here, because buzz spawns
/// *detached* respawn tasks that can race. HQ's supervisor is a plain
/// `&mut self` state machine, so the borrow checker already provides that
/// exclusion, and a latch cleared after an `.await` would leak `true` forever
/// the first time its future was dropped. It is deliberately not ported —
/// see the supervisor's `recover` path.
#[derive(Debug, Default)]
pub struct SlotCircuit {
    crash_times: Vec<Instant>,
    open_until: Option<Instant>,
}

impl SlotCircuit {
    /// A fresh breaker with no crash history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of crashes currently inside the counting window. Surfaced in
    /// slot status so the UI can show "this slot is flapping" before the
    /// breaker actually trips.
    pub fn recent_crashes(&self) -> usize {
        self.crash_times.len()
    }

    /// True while the circuit is open and the cooldown has not elapsed.
    pub fn is_open(&self) -> bool {
        self.is_open_at(Instant::now())
    }

    /// [`is_open`](Self::is_open) against a caller-supplied clock.
    pub fn is_open_at(&self, now: Instant) -> bool {
        matches!(self.open_until, Some(until) if now < until)
    }

    /// Record a crash and decide whether to respawn.
    ///
    /// This is the **single canonical path** for all crash → respawn decisions.
    /// Recording a crash more than once per real crash halves the effective
    /// breaker threshold, so callers must funnel every crash through here
    /// exactly once (see the supervisor's `recover` path).
    pub fn record_crash(&mut self) -> CrashVerdict {
        self.record_crash_at(Instant::now())
    }

    /// [`record_crash`](Self::record_crash) against a caller-supplied clock.
    ///
    /// The deterministic-time variant exists because the breaker's own
    /// constants (a 60s window, a 300s cooldown) are wall-clock quantities: a
    /// test that proved half-open behaviour by sleeping would take five
    /// minutes. Production callers use the no-arg wrapper.
    pub fn record_crash_at(&mut self, now: Instant) -> CrashVerdict {
        // Half-open: cooldown elapsed → allow one probe.
        if let Some(open_until) = self.open_until {
            if now >= open_until {
                // Pre-seed crash_times to threshold-1 so that if the probe
                // itself crashes on the *next* call, the threshold is hit
                // immediately and the circuit re-opens. This implements a
                // "prove stability for one full window" policy.
                self.crash_times.clear();
                for _ in 0..(CIRCUIT_BREAKER_THRESHOLD - 1) {
                    self.crash_times.push(now);
                }
                self.open_until = None;
                return CrashVerdict::HalfOpenProbe;
            }
            return CrashVerdict::CircuitOpen;
        }

        // Record this crash and prune old entries.
        self.crash_times.push(now);
        self.crash_times
            .retain(|&t| now.saturating_duration_since(t) < CIRCUIT_BREAKER_WINDOW);

        let recent = self.crash_times.len();

        if recent >= CIRCUIT_BREAKER_THRESHOLD {
            self.open_until = Some(now + CIRCUIT_BREAKER_COOLDOWN);
            return CrashVerdict::CircuitOpen;
        }

        // Exponential backoff: 1s * 2^(recent-1), capped at 30s, with ±20% jitter.
        let base = RESPAWN_BASE_DELAY.saturating_mul(1u32 << (recent - 1).min(5));
        let capped = base.min(RESPAWN_MAX_DELAY);
        CrashVerdict::Respawn(capped.mul_f64(jitter_factor()))
    }

    /// Mark a spawn failure — opens the circuit so the slot isn't retried on
    /// every heartbeat tick. Uses a fresh `Instant::now()` so spawn latency
    /// doesn't shorten the effective cooldown.
    pub fn mark_spawn_failed(&mut self) {
        self.mark_spawn_failed_at(Instant::now());
    }

    /// [`mark_spawn_failed`](Self::mark_spawn_failed) against a caller clock.
    pub fn mark_spawn_failed_at(&mut self, now: Instant) {
        self.open_until = Some(now + CIRCUIT_BREAKER_COOLDOWN);
    }

    /// Check if an empty slot can be refilled. Unlike
    /// [`record_crash`](Self::record_crash) this does **not** record a new
    /// crash — it only asks whether the circuit permits a respawn attempt.
    ///
    /// For half-open probes it pre-seeds `crash_times` so the next crash
    /// re-opens immediately. For normal refills (no circuit was ever opened)
    /// crash history is preserved so the breaker can still trip if the
    /// refilled agent crashes quickly.
    pub fn can_refill(&mut self) -> bool {
        self.can_refill_at(Instant::now())
    }

    /// [`can_refill`](Self::can_refill) against a caller-supplied clock.
    pub fn can_refill_at(&mut self, now: Instant) -> bool {
        match self.open_until {
            Some(open_until) => {
                if now >= open_until {
                    // Half-open probe: pre-seed crash_times.
                    self.crash_times.clear();
                    for _ in 0..(CIRCUIT_BREAKER_THRESHOLD - 1) {
                        self.crash_times.push(now);
                    }
                    self.open_until = None;
                    true
                } else {
                    false // cooldown not elapsed
                }
            }
            None => true, // no circuit open — normal refill, preserve crash history
        }
    }
}

/// Jitter multiplier in `0.8..1.2`, derived from the sub-second component of
/// the wall clock. Deliberately not a PRNG dependency — the only requirement
/// is that two slots crashing in lockstep don't retry in lockstep.
fn jitter_factor() -> f64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos() as f64;
    let jitter = nanos / 1_000_000_000.0; // 0.0..1.0
    0.8 + jitter * 0.4
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed origin so every assertion below is against a deterministic clock.
    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn three_crashes_inside_the_window_open_the_circuit() {
        let mut c = SlotCircuit::new();
        let t = t0();

        assert!(matches!(c.record_crash_at(t), CrashVerdict::Respawn(_)));
        assert!(matches!(
            c.record_crash_at(t + Duration::from_secs(1)),
            CrashVerdict::Respawn(_)
        ));
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(2)),
            CrashVerdict::CircuitOpen,
            "third crash inside the 60s window must open the circuit"
        );
        assert!(c.is_open_at(t + Duration::from_secs(3)));
    }

    #[test]
    fn a_crash_inside_the_cooldown_keeps_the_circuit_open() {
        let mut c = SlotCircuit::new();
        let t = t0();
        c.record_crash_at(t);
        c.record_crash_at(t + Duration::from_secs(1));
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(2)),
            CrashVerdict::CircuitOpen
        );

        // 299s in — still inside the 300s cooldown.
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(299)),
            CrashVerdict::CircuitOpen,
            "a fourth crash inside the cooldown must not be allowed to respawn"
        );
        // can_refill agrees.
        assert!(!c.can_refill_at(t + Duration::from_secs(299)));
    }

    #[test]
    fn cooldown_elapsed_yields_a_half_open_probe_and_a_probe_crash_reopens() {
        let mut c = SlotCircuit::new();
        let t = t0();
        c.record_crash_at(t);
        c.record_crash_at(t + Duration::from_secs(1));
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(2)),
            CrashVerdict::CircuitOpen
        );

        // Cooldown started at t+2s, so t+301s is past t+302s? No — assert the
        // documented boundary explicitly: open_until == t+2s+300s == t+302s.
        assert!(
            c.is_open_at(t + Duration::from_secs(301)),
            "still open one second before the cooldown expires"
        );

        let probe = c.record_crash_at(t + Duration::from_secs(303));
        assert_eq!(
            probe,
            CrashVerdict::HalfOpenProbe,
            "after the cooldown elapses the breaker must allow exactly one probe"
        );

        // Pre-seed policy: the probe crashing re-opens the circuit immediately,
        // without waiting for two more crashes.
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(304)),
            CrashVerdict::CircuitOpen,
            "a crash right after the half-open probe must re-open immediately"
        );
    }

    #[test]
    fn can_refill_half_open_pre_seeds_so_the_next_crash_reopens() {
        let mut c = SlotCircuit::new();
        let t = t0();
        c.mark_spawn_failed_at(t);
        assert!(!c.can_refill_at(t + Duration::from_secs(10)));
        assert!(c.can_refill_at(t + Duration::from_secs(301)));
        assert_eq!(c.recent_crashes(), CIRCUIT_BREAKER_THRESHOLD - 1);
        assert_eq!(
            c.record_crash_at(t + Duration::from_secs(302)),
            CrashVerdict::CircuitOpen
        );
    }

    #[test]
    fn crashes_outside_the_window_are_pruned() {
        let mut c = SlotCircuit::new();
        let t = t0();
        c.record_crash_at(t);
        c.record_crash_at(t + Duration::from_secs(1));
        // Third crash lands 61s after the first two — both are pruned, so this
        // counts as crash #1 and must be a plain respawn, not an open circuit.
        assert!(matches!(
            c.record_crash_at(t + Duration::from_secs(62)),
            CrashVerdict::Respawn(_)
        ));
        assert_eq!(c.recent_crashes(), 1);
    }

    #[test]
    fn backoff_doubles_and_stays_inside_the_jitter_band() {
        // ±20% band around the nominal 1s / 2s exponential schedule.
        let mut c = SlotCircuit::new();
        let t = t0();

        let first = match c.record_crash_at(t) {
            CrashVerdict::Respawn(d) => d,
            other => panic!("expected Respawn, got {other:?}"),
        };
        assert!(
            first >= Duration::from_millis(800) && first <= Duration::from_millis(1200),
            "first backoff {first:?} outside the ±20% band around 1s"
        );

        let second = match c.record_crash_at(t + Duration::from_secs(1)) {
            CrashVerdict::Respawn(d) => d,
            other => panic!("expected Respawn, got {other:?}"),
        };
        assert!(
            second >= Duration::from_millis(1600) && second <= Duration::from_millis(2400),
            "second backoff {second:?} outside the ±20% band around 2s"
        );
    }

    #[test]
    fn every_backoff_the_breaker_can_actually_emit_respects_the_cap() {
        // Driven through the real state machine, not a re-implementation of its
        // formula: the earlier version of this test recomputed
        // `base.min(RESPAWN_MAX_DELAY)` inline and asserted it against itself,
        // so it would have passed with `record_crash_at` deleted entirely.
        //
        // Worth knowing while reading this: with CIRCUIT_BREAKER_THRESHOLD == 3
        // the cap is *unreachable*. Only two `Respawn` verdicts are ever
        // emitted inside a window (1s and 2s nominal) before the third crash
        // opens the circuit, so the 30s ceiling is headroom for a future
        // threshold, not a value production ever hits. The assertion below is
        // therefore a guard against that constant changing, and the exact-value
        // schedule is covered by `backoff_doubles_and_stays_inside_the_jitter_band`.
        let ceiling = RESPAWN_MAX_DELAY.mul_f64(1.2);
        let mut c = SlotCircuit::new();
        let t = t0();

        let mut respawns = 0;
        for i in 0..CIRCUIT_BREAKER_THRESHOLD + 3 {
            // Every crash inside one window, so nothing is pruned.
            match c.record_crash_at(t + Duration::from_secs(i as u64)) {
                CrashVerdict::Respawn(d) => {
                    respawns += 1;
                    assert!(
                        d <= ceiling,
                        "crash {i} produced backoff {d:?}, above the {ceiling:?} ceiling"
                    );
                }
                CrashVerdict::CircuitOpen | CrashVerdict::HalfOpenProbe => {}
            }
        }
        assert_eq!(
            respawns,
            CIRCUIT_BREAKER_THRESHOLD - 1,
            "the breaker emits exactly threshold-1 backoffs before opening"
        );
    }

    #[test]
    fn a_fresh_circuit_permits_refill() {
        let mut c = SlotCircuit::new();
        assert!(c.can_refill());
        assert!(!c.is_open());
        assert_eq!(c.recent_crashes(), 0);
    }

    #[test]
    fn jitter_factor_stays_inside_the_declared_band() {
        for _ in 0..64 {
            let f = jitter_factor();
            assert!((0.8..=1.2).contains(&f), "jitter factor {f} out of band");
        }
    }
}
