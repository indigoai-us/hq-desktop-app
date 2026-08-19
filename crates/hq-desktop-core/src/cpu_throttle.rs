//! A machine-wide CPU ceiling for HQ's background work.
//!
//! Sync and the git mirror walk a tree that can hold hundreds of thousands of
//! files, and on a large HQ root that is genuinely expensive: hashing every
//! changed file, diffing manifests, and re-walking on every pass. Left alone the
//! sync runner settles around 1.4 cores, which is what an operator feels as
//! "the app is eating my machine".
//!
//! The ceiling is expressed as a share of the *whole machine*, not of one core,
//! because that is the number an operator actually cares about: 5% means the
//! background work may use at most 5% of everything the box can do, whether the
//! box has 4 cores or 24.
//!
//! ## How the ceiling is enforced
//!
//! There is no per-process CPU quota on macOS, so the throttle duty-cycles the
//! child's process group with `SIGSTOP`/`SIGCONT`. A supervisor thread samples
//! the group's cumulative CPU time once a second, converts it to a rate in
//! cores, and adjusts what fraction of each 200 ms cycle the group is allowed to
//! run. Cycles are deliberately short: a stop window is at most ~196 ms, well
//! inside the tolerance of the TCP and TLS connections the sync runner holds
//! open, so throttling slows a transfer down rather than breaking it.
//!
//! Two invariants matter more than the arithmetic:
//!
//! 1. **Never leave a group stopped.** Every exit path — drop, thread panic,
//!    supervisor shutdown, group death — issues a final `SIGCONT`. A stranded
//!    `SIGSTOP` would wedge a sync forever while looking like a hang.
//! 2. **Never stop something that is not ours.** The throttle only ever signals
//!    a process group HQ created for this child. A pgid of 0 or 1, or the
//!    caller's own group, is refused outright: `killpg(0, SIGSTOP)` would stop
//!    the whole app.
//!
//! The controller is a pure struct with no I/O so the convergence behaviour is
//! unit-testable, and both the sampler and the signaller are traits so the
//! supervisor loop can be driven against fakes.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Share of the whole machine HQ's background work may use, as a percentage.
pub const DEFAULT_MAX_MACHINE_CPU_PERCENT: f64 = 5.0;

/// Env override. A value of `0`, a negative number, or `off`/`false`/`none`
/// disables throttling entirely; anything unparseable falls back to the default
/// rather than silently running uncapped.
pub const MAX_CPU_ENV: &str = "HQ_MAX_CPU_PERCENT";

/// Length of one stop/run cycle. Short enough that a stop window cannot trip a
/// network timeout, long enough that signalling overhead stays negligible.
const CYCLE: Duration = Duration::from_millis(200);

/// How often the supervisor re-measures the group and re-tunes the duty cycle.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(1000);

/// Never freeze a group outright: even a hard-over-budget group keeps a sliver
/// of runtime so it can finish a syscall, release a lock, and make progress.
const MIN_RUN_FRACTION: f64 = 0.02;

/// Fraction of the correction applied per sample. Damps the controller so a
/// single noisy measurement cannot slam the group to the floor.
const SMOOTHING: f64 = 0.5;

/// A run fraction at or above this is treated as "unthrottled" — the supervisor
/// issues no signals at all, so an idle or cheap child pays nothing.
const UNTHROTTLED_FRACTION: f64 = 0.999;

/// Resolve the configured ceiling. `None` means throttling is off.
pub fn configured_max_machine_cpu_percent() -> Option<f64> {
    match std::env::var(MAX_CPU_ENV) {
        Err(_) => Some(DEFAULT_MAX_MACHINE_CPU_PERCENT),
        Ok(raw) => parse_max_machine_cpu_percent(&raw),
    }
}

/// Parse an [`MAX_CPU_ENV`] value. Split out so the precedence rules are
/// testable without touching real process env.
pub fn parse_max_machine_cpu_percent(raw: &str) -> Option<f64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(DEFAULT_MAX_MACHINE_CPU_PERCENT);
    }
    match trimmed.to_ascii_lowercase().as_str() {
        "off" | "false" | "none" | "disabled" => return None,
        _ => {}
    }
    match trimmed.parse::<f64>() {
        // A finite, positive percentage caps at 100 (the whole machine) — a
        // larger number is not an error, it just means "do not throttle".
        Ok(v) if v.is_finite() && v > 0.0 => {
            if v >= 100.0 {
                None
            } else {
                Some(v)
            }
        }
        // Explicit zero or negative: the operator asked for no CPU, which we
        // read as "off" rather than "freeze forever".
        Ok(_) => None,
        // Unparseable: fall back to the default. Running uncapped because of a
        // typo is the worse failure.
        Err(_) => Some(DEFAULT_MAX_MACHINE_CPU_PERCENT),
    }
}

/// Machine capacity in cores, used to turn a machine-share percentage into an
/// absolute core budget.
pub fn machine_cores() -> f64 {
    std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0)
}

/// Convert a share-of-machine percentage into a core budget.
pub fn target_cores(max_machine_cpu_percent: f64, cores: f64) -> f64 {
    (max_machine_cpu_percent / 100.0 * cores).max(0.0)
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure controller
// ─────────────────────────────────────────────────────────────────────────────

/// Decides what fraction of each cycle the group may run.
///
/// The group's *demand* — what it would use uncapped — is inferred from what it
/// actually used while it was allowed to run: a group measured at 0.5 cores
/// while running half the time is really asking for 1.0. The fraction that
/// lands demand on the budget is therefore `target / demand`, approached in
/// damped steps so one noisy sample cannot slam the group to the floor.
#[derive(Debug, Clone)]
pub struct DutyCycleController {
    target_cores: f64,
    run_fraction: f64,
}

impl DutyCycleController {
    pub fn new(target_cores: f64) -> Self {
        Self {
            target_cores: target_cores.max(0.0),
            // Start unthrottled: a child that never approaches the budget
            // should never be signalled at all.
            run_fraction: 1.0,
        }
    }

    pub fn run_fraction(&self) -> f64 {
        self.run_fraction
    }

    /// Feed the rate (in cores) the group sustained over the last window, and
    /// get the run fraction to apply next.
    pub fn observe(&mut self, measured_cores: f64) -> f64 {
        if !measured_cores.is_finite() || measured_cores < 0.0 {
            // A bad sample tells us nothing; hold the current fraction rather
            // than reacting to noise.
            return self.run_fraction;
        }
        let demand = if self.run_fraction > f64::EPSILON {
            measured_cores / self.run_fraction
        } else {
            measured_cores
        };
        let desired = if demand <= self.target_cores || demand <= f64::EPSILON {
            1.0
        } else {
            self.target_cores / demand
        };
        self.run_fraction += (desired - self.run_fraction) * SMOOTHING;
        self.run_fraction = self.run_fraction.clamp(MIN_RUN_FRACTION, 1.0);
        self.run_fraction
    }

    /// Split a cycle into (run, stop). A stop of zero means "issue no signals".
    pub fn cycle_split(&self, cycle: Duration) -> (Duration, Duration) {
        if self.run_fraction >= UNTHROTTLED_FRACTION {
            return (cycle, Duration::ZERO);
        }
        let run = cycle.mul_f64(self.run_fraction);
        (run, cycle.saturating_sub(run))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Seams
// ─────────────────────────────────────────────────────────────────────────────

/// Cumulative CPU time consumed by a set of process groups.
pub trait CpuSampler: Send + Sync + 'static {
    /// Total CPU seconds consumed by every live process in any of `pgids`, or
    /// `None` when none of them has a live member left.
    fn groups_cpu_seconds(&self, pgids: &[i32]) -> Option<f64>;
}

/// Stop/continue a process group.
pub trait GroupSignaller: Send + Sync + 'static {
    fn stop(&self, pgid: i32);
    fn cont(&self, pgid: i32);
}

/// A pgid HQ may signal. Refuses the values that would take the app down with
/// the child: `0` (the caller's own group), `1` (init), and anything negative.
pub fn is_signalable_group(pgid: i32, own_pgid: i32) -> bool {
    pgid > 1 && pgid != own_pgid
}

// ─────────────────────────────────────────────────────────────────────────────
// Governor
// ─────────────────────────────────────────────────────────────────────────────

/// The ceiling covers *all* of HQ's background work at once, not each process
/// separately: the sync runner and the git mirror share one budget, so two
/// concurrent throttled groups get 5% between them rather than 5% each.
///
/// That is why membership lives in a single governor with one controller and
/// one duty cycle applied to every registered group in lockstep, instead of a
/// per-child supervisor. It also means the arithmetic stays honest as groups
/// come and go — a mirror pass starting mid-sync tightens the sync's share
/// rather than adding to it.
pub struct Governor<S: CpuSampler, G: GroupSignaller> {
    groups: Vec<i32>,
    controller: DutyCycleController,
    sampler: S,
    signaller: G,
    last_cpu_seconds: Option<f64>,
}

/// What the governor wants applied for the next cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    /// Apply this run/stop split to every registered group.
    Cycle { run: Duration, stop: Duration },
    /// Nothing is registered — nothing to supervise.
    Idle,
}

impl<S: CpuSampler, G: GroupSignaller> Governor<S, G> {
    pub fn new(target_cores: f64, sampler: S, signaller: G) -> Self {
        Self {
            groups: Vec::new(),
            controller: DutyCycleController::new(target_cores),
            sampler,
            signaller,
            last_cpu_seconds: None,
        }
    }

    pub fn run_fraction(&self) -> f64 {
        self.controller.run_fraction()
    }

    pub fn groups(&self) -> &[i32] {
        &self.groups
    }

    pub fn register(&mut self, pgid: i32) {
        if !self.groups.contains(&pgid) {
            self.groups.push(pgid);
            // Membership changed, so the cumulative sum just jumped by the new
            // member's accumulated CPU. That jump is not consumption in this
            // window; drop the baseline and re-establish it next sample.
            self.last_cpu_seconds = None;
        }
    }

    pub fn unregister(&mut self, pgid: i32) {
        if let Some(i) = self.groups.iter().position(|p| *p == pgid) {
            self.groups.remove(i);
            self.last_cpu_seconds = None;
            // A group that leaves the governor must never leave stopped.
            self.signaller.cont(pgid);
        }
    }

    /// Re-measure the whole registered set and re-tune the shared duty cycle.
    /// `elapsed` is the wall time since the previous sample.
    pub fn sample(&mut self, elapsed: Duration) -> Tick {
        if self.groups.is_empty() {
            self.last_cpu_seconds = None;
            return Tick::Idle;
        }
        let Some(now_cpu) = self.sampler.groups_cpu_seconds(&self.groups) else {
            // Every registered group is gone. Keep them registered — their
            // owning guards will unregister on drop — but stop steering on a
            // measurement that no longer exists.
            self.last_cpu_seconds = None;
            return Tick::Idle;
        };
        let prev = self.last_cpu_seconds.replace(now_cpu);
        let wall = elapsed.as_secs_f64();
        if let (Some(prev), true) = (prev, wall > f64::EPSILON) {
            let delta = now_cpu - prev;
            // A negative delta means a process exited and took its accumulated
            // time out of the sum — not a measurement of this window.
            if delta >= 0.0 {
                self.controller.observe(delta / wall);
            }
        }
        let (run, stop) = self.controller.cycle_split(CYCLE);
        Tick::Cycle { run, stop }
    }

    /// Stop every registered group.
    pub fn stop_all(&self) {
        for pgid in &self.groups {
            self.signaller.stop(*pgid);
        }
    }

    /// Resume every registered group.
    pub fn resume_all(&self) {
        for pgid in &self.groups {
            self.signaller.cont(*pgid);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Process-wide governor + RAII guard
// ─────────────────────────────────────────────────────────────────────────────

type SharedGovernor = Arc<Mutex<Governor<PsSampler, KillpgSignaller>>>;

static GOVERNOR: OnceLock<Option<SharedGovernor>> = OnceLock::new();

/// The single governor for this process, or `None` when throttling is off.
/// Built once: the ceiling is read at startup so a mid-run env change cannot
/// half-apply across concurrent children.
fn governor() -> Option<&'static SharedGovernor> {
    GOVERNOR
        .get_or_init(|| {
            let percent = configured_max_machine_cpu_percent()?;
            let target = target_cores(percent, machine_cores());
            let shared: SharedGovernor = Arc::new(Mutex::new(Governor::new(
                target,
                PsSampler,
                KillpgSignaller,
            )));
            let thread_ref = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("hq-cpu-governor".into())
                .spawn(move || governor_loop(thread_ref))
                .ok()?;
            Some(shared)
        })
        .as_ref()
}

fn governor_loop(shared: SharedGovernor) {
    let mut last_sample = Instant::now();
    let mut elapsed = SAMPLE_INTERVAL;
    loop {
        let tick = match shared.lock() {
            Ok(mut g) => g.sample(elapsed),
            // A poisoned governor must not leave anything stopped.
            Err(poisoned) => {
                poisoned.into_inner().resume_all();
                return;
            }
        };
        match tick {
            Tick::Idle => std::thread::sleep(SAMPLE_INTERVAL),
            Tick::Cycle { .. } => {
                let deadline = Instant::now() + SAMPLE_INTERVAL;
                while Instant::now() < deadline {
                    let Ok(g) = shared.lock() else { return };
                    let (run, stop) = g.controller.cycle_split(CYCLE);
                    if g.groups.is_empty() {
                        break;
                    }
                    if stop.is_zero() {
                        g.resume_all();
                        drop(g);
                        std::thread::sleep(run);
                    } else {
                        g.resume_all();
                        drop(g);
                        std::thread::sleep(run);
                        let Ok(g) = shared.lock() else { return };
                        g.stop_all();
                        drop(g);
                        std::thread::sleep(stop);
                    }
                }
            }
        }
        let now = Instant::now();
        elapsed = now.duration_since(last_sample);
        last_sample = now;
    }
}

/// Registers a child's process group with the shared governor for as long as it
/// is held. Dropping it unregisters and resumes that group, so no exit path —
/// normal return, early error, timeout kill, panic unwind — can strand a
/// stopped child.
pub struct CpuThrottle {
    pgid: i32,
}

impl CpuThrottle {
    /// Put `pgid` under HQ's shared CPU ceiling. Returns `None` when throttling
    /// is disabled, the platform is unsupported, or `pgid` is not one we may
    /// signal.
    pub fn attach(pgid: i32) -> Option<Self> {
        if !cfg!(unix) {
            return None;
        }
        if !is_signalable_group(pgid, own_process_group()) {
            return None;
        }
        let gov = governor()?;
        gov.lock().ok()?.register(pgid);
        Some(Self { pgid })
    }
}

impl Drop for CpuThrottle {
    fn drop(&mut self) {
        if let Some(gov) = governor() {
            match gov.lock() {
                // `unregister` issues the SIGCONT.
                Ok(mut g) => g.unregister(self.pgid),
                Err(poisoned) => poisoned.into_inner().signaller.cont(self.pgid),
            }
        }
    }
}

#[cfg(unix)]
fn own_process_group() -> i32 {
    unsafe { libc::getpgrp() }
}

#[cfg(not(unix))]
fn own_process_group() -> i32 {
    0
}

// ─────────────────────────────────────────────────────────────────────────────
// Production seams
// ─────────────────────────────────────────────────────────────────────────────

/// Samples cumulative group CPU with one `ps` call. `ps` is used rather than
/// libproc FFI because the whole point of this module is to *reduce* load: one
/// short-lived `ps` per second is a rounding error next to what it saves, and it
/// keeps the sampler auditable.
pub struct PsSampler;

impl CpuSampler for PsSampler {
    fn groups_cpu_seconds(&self, pgids: &[i32]) -> Option<f64> {
        let out = std::process::Command::new("ps")
            .args(["-A", "-o", "pgid=,time="])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        sum_groups_cpu_seconds(&String::from_utf8_lossy(&out.stdout), pgids)
    }
}

/// Sum the CPU time of every row whose pgid is in `pgids`. `None` when no row
/// is, which is how a fully dead set is reported.
pub fn sum_groups_cpu_seconds(ps_stdout: &str, pgids: &[i32]) -> Option<f64> {
    let mut total = 0.0;
    let mut seen = false;
    for line in ps_stdout.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pg), Some(time)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(pg) = pg.parse::<i32>() else { continue };
        if !pgids.contains(&pg) {
            continue;
        }
        if let Some(secs) = parse_ps_time(time) {
            total += secs;
            seen = true;
        }
    }
    seen.then_some(total)
}

/// Parse `ps -o time=`: `MM:SS.ss`, `HH:MM:SS`, or `DD-HH:MM:SS`.
pub fn parse_ps_time(raw: &str) -> Option<f64> {
    let (days, rest) = match raw.split_once('-') {
        Some((d, rest)) => (d.parse::<f64>().ok()?, rest),
        None => (0.0, raw),
    };
    let mut secs = 0.0;
    let mut any = false;
    for part in rest.split(':') {
        let v = part.parse::<f64>().ok()?;
        secs = secs * 60.0 + v;
        any = true;
    }
    any.then_some(days * 86_400.0 + secs)
}

/// Signals a whole process group with `killpg`.
#[derive(Clone, Copy)]
pub struct KillpgSignaller;

#[cfg(unix)]
impl GroupSignaller for KillpgSignaller {
    fn stop(&self, pgid: i32) {
        unsafe {
            libc::killpg(pgid, libc::SIGSTOP);
        }
    }
    fn cont(&self, pgid: i32) {
        unsafe {
            libc::killpg(pgid, libc::SIGCONT);
        }
    }
}

#[cfg(not(unix))]
impl GroupSignaller for KillpgSignaller {
    fn stop(&self, _pgid: i32) {}
    fn cont(&self, _pgid: i32) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct RecordingSignaller {
        stops: Arc<Mutex<Vec<i32>>>,
        conts: Arc<Mutex<Vec<i32>>>,
    }

    impl GroupSignaller for RecordingSignaller {
        fn stop(&self, pgid: i32) {
            self.stops.lock().unwrap().push(pgid);
        }
        fn cont(&self, pgid: i32) {
            self.conts.lock().unwrap().push(pgid);
        }
    }

    /// Returns scripted totals, and records the pgid set it was asked about.
    struct ScriptedSampler {
        script: Mutex<Vec<Option<f64>>>,
        asked: Mutex<Vec<Vec<i32>>>,
        calls: AtomicUsize,
    }

    impl ScriptedSampler {
        fn new(script: Vec<Option<f64>>) -> Self {
            Self {
                script: Mutex::new(script),
                asked: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl CpuSampler for ScriptedSampler {
        fn groups_cpu_seconds(&self, pgids: &[i32]) -> Option<f64> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.asked.lock().unwrap().push(pgids.to_vec());
            let mut s = self.script.lock().unwrap();
            if s.is_empty() {
                None
            } else {
                s.remove(0)
            }
        }
    }

    fn governor(
        target: f64,
        script: Vec<Option<f64>>,
    ) -> (
        Governor<ScriptedSampler, RecordingSignaller>,
        RecordingSignaller,
    ) {
        let sig = RecordingSignaller::default();
        (
            Governor::new(target, ScriptedSampler::new(script), sig.clone()),
            sig,
        )
    }

    // --- config parsing ----------------------------------------------------

    #[test]
    fn default_ceiling_is_five_percent_of_the_machine() {
        assert_eq!(DEFAULT_MAX_MACHINE_CPU_PERCENT, 5.0);
        assert_eq!(parse_max_machine_cpu_percent(""), Some(5.0));
    }

    #[test]
    fn ceiling_is_a_share_of_the_whole_machine_not_one_core() {
        // 5% of a 10-core box is half a core, not 5% of one core.
        assert!((target_cores(5.0, 10.0) - 0.5).abs() < 1e-9);
        assert!((target_cores(5.0, 4.0) - 0.2).abs() < 1e-9);
        assert!((target_cores(5.0, 24.0) - 1.2).abs() < 1e-9);
    }

    #[test]
    fn explicit_off_values_disable_throttling() {
        for raw in ["off", "OFF", "false", "none", "disabled", "0", "-1"] {
            assert_eq!(parse_max_machine_cpu_percent(raw), None, "raw={raw}");
        }
    }

    #[test]
    fn a_ceiling_of_the_whole_machine_or_more_is_no_ceiling() {
        assert_eq!(parse_max_machine_cpu_percent("100"), None);
        assert_eq!(parse_max_machine_cpu_percent("250"), None);
    }

    #[test]
    fn a_typo_falls_back_to_the_default_rather_than_running_uncapped() {
        assert_eq!(parse_max_machine_cpu_percent("banana"), Some(5.0));
        assert_eq!(parse_max_machine_cpu_percent("5%"), Some(5.0));
    }

    // --- controller --------------------------------------------------------

    #[test]
    fn a_group_under_budget_is_never_throttled() {
        let mut c = DutyCycleController::new(0.5);
        for _ in 0..10 {
            c.observe(0.2);
        }
        assert_eq!(c.run_fraction(), 1.0);
        assert_eq!(c.cycle_split(CYCLE), (CYCLE, Duration::ZERO));
    }

    #[test]
    fn an_over_budget_group_converges_on_the_budget() {
        let target = 0.5;
        let demand = 1.4;
        let mut c = DutyCycleController::new(target);
        let mut measured = demand;
        for _ in 0..40 {
            let f = c.observe(measured);
            measured = demand * f; // what it manages while running `f` of the time
        }
        assert!(
            (measured - target).abs() < 0.02,
            "settled at {measured} cores, wanted ~{target}"
        );
    }

    #[test]
    fn the_group_is_never_frozen_outright() {
        let mut c = DutyCycleController::new(0.001);
        for _ in 0..100 {
            c.observe(64.0);
        }
        assert!(c.run_fraction() >= MIN_RUN_FRACTION);
        let (run, _) = c.cycle_split(CYCLE);
        assert!(run > Duration::ZERO, "a throttled group must still run");
    }

    #[test]
    fn a_stop_window_stays_short_enough_not_to_trip_a_network_timeout() {
        let mut c = DutyCycleController::new(0.001);
        for _ in 0..100 {
            c.observe(64.0);
        }
        let (_, stop) = c.cycle_split(CYCLE);
        assert!(stop < CYCLE, "stop window {stop:?} is a whole cycle");
    }

    #[test]
    fn a_bad_sample_holds_the_current_fraction() {
        let mut c = DutyCycleController::new(0.5);
        c.observe(2.0);
        let before = c.run_fraction();
        c.observe(f64::NAN);
        c.observe(-1.0);
        assert_eq!(c.run_fraction(), before);
    }

    #[test]
    fn recovery_is_gradual_when_demand_collapses() {
        let mut c = DutyCycleController::new(0.5);
        for _ in 0..40 {
            c.observe(2.0);
        }
        let throttled = c.run_fraction();
        assert!(throttled < 0.5);
        c.observe(0.0);
        assert!(c.run_fraction() > throttled);
        assert!(
            c.run_fraction() < 1.0,
            "a bursty child must not snap to full speed"
        );
    }

    // --- group safety ------------------------------------------------------

    #[test]
    fn refuses_to_signal_groups_that_would_take_the_app_down() {
        assert!(
            !is_signalable_group(0, 4242),
            "pgid 0 is the caller's group"
        );
        assert!(!is_signalable_group(1, 4242), "pgid 1 is init");
        assert!(!is_signalable_group(-5, 4242));
        assert!(!is_signalable_group(4242, 4242), "our own group");
        assert!(is_signalable_group(4243, 4242));
    }

    // --- governor: the shared budget ---------------------------------------

    #[test]
    fn the_budget_is_shared_across_every_group_not_per_group() {
        // Two groups, 0.5-core budget between them. Together they burn 2.0
        // cores in one wall second, so the governor must throttle — a per-group
        // budget would see 1.0 each and (wrongly) allow it.
        let (mut g, _sig) = governor(0.5, vec![Some(0.0), Some(2.0)]);
        g.register(100);
        g.register(200);
        g.sample(SAMPLE_INTERVAL);
        let tick = g.sample(SAMPLE_INTERVAL);
        let Tick::Cycle { stop, .. } = tick else {
            panic!("expected a cycle, got {tick:?}");
        };
        assert!(stop > Duration::ZERO, "shared budget was not enforced");
        assert!(g.run_fraction() < 1.0);
    }

    #[test]
    fn every_registered_group_is_sampled_and_signalled_together() {
        let (mut g, sig) = governor(0.5, vec![Some(0.0), Some(4.0)]);
        g.register(100);
        g.register(200);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(
            g.sampler.asked.lock().unwrap().last().unwrap(),
            &vec![100, 200],
            "sampler must see the whole set"
        );
        g.stop_all();
        assert_eq!(*sig.stops.lock().unwrap(), vec![100, 200]);
        g.resume_all();
        assert_eq!(*sig.conts.lock().unwrap(), vec![100, 200]);
    }

    #[test]
    fn a_group_joining_mid_run_tightens_the_share_rather_than_adding_to_it() {
        // The mirror starting during a sync must not double the ceiling.
        let (mut g, _sig) = governor(0.5, vec![Some(0.0), Some(1.0), Some(3.0)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        let solo = g.run_fraction();
        g.register(200);
        // Membership changed: the first post-change sample only re-baselines.
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(
            g.run_fraction(),
            solo,
            "the membership jump steered the controller"
        );
        assert_eq!(g.groups(), &[100, 200]);
    }

    #[test]
    fn membership_change_does_not_read_as_a_cpu_spike() {
        // 10s accumulated, then a second group with 900s joins: the sum leaps
        // to 910 for reasons that have nothing to do with this window.
        let (mut g, _sig) = governor(0.5, vec![Some(10.0), Some(910.0), Some(910.1)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.register(200);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(
            g.run_fraction(),
            1.0,
            "a membership jump was read as demand"
        );
    }

    #[test]
    fn unregistering_resumes_that_group_immediately() {
        let (mut g, sig) = governor(0.5, vec![]);
        g.register(100);
        g.register(200);
        g.unregister(100);
        assert_eq!(*sig.conts.lock().unwrap(), vec![100]);
        assert_eq!(g.groups(), &[200]);
    }

    #[test]
    fn an_empty_governor_is_idle_and_never_samples() {
        let (mut g, _sig) = governor(0.5, vec![Some(1.0)]);
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        assert_eq!(g.sampler.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_fully_dead_set_goes_idle_without_steering() {
        let (mut g, _sig) = governor(0.5, vec![None]);
        g.register(100);
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        assert_eq!(g.run_fraction(), 1.0);
    }

    #[test]
    fn cpu_rate_is_derived_from_the_delta_not_the_total() {
        // 10s accumulated, then 10.5s one second later is 0.5 cores — exactly
        // the budget, so no throttling.
        let (mut g, _sig) = governor(0.5, vec![Some(10.0), Some(10.5)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(g.run_fraction(), 1.0);
    }

    #[test]
    fn a_member_exiting_does_not_read_as_negative_cpu() {
        let (mut g, _sig) = governor(0.5, vec![Some(100.0), Some(4.0), Some(4.2)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(
            g.run_fraction(),
            1.0,
            "a negative delta moved the controller"
        );
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(g.run_fraction(), 1.0);
    }

    // --- ps parsing --------------------------------------------------------

    #[test]
    fn parses_every_ps_time_shape() {
        assert_eq!(parse_ps_time("0:00.00"), Some(0.0));
        assert_eq!(parse_ps_time("1:30.50"), Some(90.5));
        assert_eq!(parse_ps_time("2:03:04"), Some(7384.0));
        assert_eq!(parse_ps_time("1-02:03:04"), Some(86_400.0 + 7384.0));
        assert_eq!(parse_ps_time("nonsense"), None);
    }

    #[test]
    fn sums_across_the_whole_registered_set() {
        let ps = "  501  0:10.00\n  502  1:00.00\n  501  0:05.00\n";
        assert_eq!(sum_groups_cpu_seconds(ps, &[501]), Some(15.0));
        assert_eq!(sum_groups_cpu_seconds(ps, &[501, 502]), Some(75.0));
    }

    #[test]
    fn a_set_with_no_rows_is_reported_gone() {
        let ps = "  501  0:10.00\n";
        assert_eq!(sum_groups_cpu_seconds(ps, &[999]), None);
    }

    #[test]
    fn malformed_ps_rows_are_skipped_not_fatal() {
        let ps = "garbage\n  501  0:10.00\n\n  501  bad\n";
        assert_eq!(sum_groups_cpu_seconds(ps, &[501]), Some(10.0));
    }
}
