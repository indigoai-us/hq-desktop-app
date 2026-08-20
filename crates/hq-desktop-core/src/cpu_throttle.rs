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

use std::collections::HashMap;
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

/// How many consecutive idle samples the governor tolerates before it forgets
/// the duty cycle its last workload earned. One sample is a gap between two
/// children of the same burst; several in a row is genuine quiet.
const IDLE_TICKS_BEFORE_CONTROLLER_RESET: u32 = 5;

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
        // `NaN` and `inf` parse successfully but are malformed limits, not the
        // documented off switches. They belong with typos: fall back to the
        // default rather than silently running uncapped.
        Ok(v) if !v.is_finite() => Some(DEFAULT_MAX_MACHINE_CPU_PERCENT),
        // A finite, positive percentage caps at 100 (the whole machine) — a
        // larger number is not an error, it just means "do not throttle".
        Ok(v) if v > 0.0 => {
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

/// A deadline that only counts time the throttled groups were allowed to run.
///
/// Every timeout in HQ's background work is a wall-clock budget that implicitly
/// grants some amount of CPU. Throttling breaks that link: a converged governor
/// can slow a one-core `git add -A` by 10x on a two-core machine, so a healthy
/// command that needed 100 of its 120 seconds is killed long before it finishes.
///
/// A multiplier cannot fix this honestly. Pick it too low and healthy work still
/// dies; pick the true worst case and a one-hour watchdog becomes twenty hours
/// and stops detecting hangs. Counting only *runnable* time removes the guess
/// entirely: the deadline means exactly what it meant before the throttle
/// existed — this much time actually working — and a genuinely wedged process,
/// which is never stopped, still trips it on the original schedule.
/// How far a runnable-time deadline may stretch in wall-clock terms before its
/// absolute backstop fires.
///
/// Runnable-time accounting alone cannot catch a wedge that spins on CPU: the
/// governor cannot tell that hang from healthy work, keeps duty-cycling it, and
/// every stop window is credited back. Without a ceiling a single-threaded
/// wedge on a two-core machine stretches a two-minute git timeout past twenty
/// wall-clock minutes. The backstop is deliberately generous — it exists to
/// bound the pathological case, not to bind on healthy throttled work.
const WALL_CLOCK_BACKSTOP: f64 = 8.0;

/// A point in time you can later ask "how much *runnable* time has passed?".
///
/// The stopped-time counter is cumulative for the whole process, so measuring a
/// window needs its value at both ends — asking only at the end would credit a
/// caller for stop windows that predate it. Callers that track their own start
/// instant (the daemon heartbeat measures from the last protocol record, not
/// from a deadline it created) take a mark instead of an `Instant`.
#[derive(Debug, Clone, Copy)]
pub struct RunnableMark {
    at: Instant,
    stopped_at: Duration,
}

impl RunnableMark {
    pub fn now() -> Self {
        Self {
            at: Instant::now(),
            stopped_at: total_stopped_time(),
        }
    }

    /// Plain wall time since the mark.
    pub fn wall_elapsed(&self) -> Duration {
        self.at.elapsed()
    }

    /// Wall time since the mark, less any of it spent under `SIGSTOP`.
    pub fn runnable_elapsed(&self) -> Duration {
        let wall = self.wall_elapsed();
        let stopped = total_stopped_time().saturating_sub(self.stopped_at);
        wall.saturating_sub(stopped)
    }
}

impl Default for RunnableMark {
    fn default() -> Self {
        Self::now()
    }
}

pub struct RunnableDeadline {
    mark: RunnableMark,
    budget: Duration,
}

impl RunnableDeadline {
    pub fn start(budget: Duration) -> Self {
        Self {
            mark: RunnableMark::now(),
            budget,
        }
    }

    /// Wall time elapsed, less any of it spent under `SIGSTOP`.
    pub fn runnable_elapsed(&self) -> Duration {
        self.mark.runnable_elapsed()
    }

    /// True once the work has used its runnable-time budget, OR once wall time
    /// has run far past it — the second arm catches a wedge that spins on CPU,
    /// which the governor keeps stopping and which would otherwise be credited
    /// stop windows forever.
    pub fn expired(&self) -> bool {
        self.runnable_elapsed() >= self.budget || self.mark.wall_elapsed() >= self.wall_backstop()
    }

    /// Absolute wall-clock ceiling, regardless of how much of it was stopped.
    pub fn wall_backstop(&self) -> Duration {
        self.budget.mul_f64(WALL_CLOCK_BACKSTOP)
    }

    /// Which arm ended it — for log lines that would otherwise misreport a
    /// wall-clock kill as a runnable-time one.
    pub fn hit_wall_backstop(&self) -> bool {
        self.mark.wall_elapsed() >= self.wall_backstop() && self.runnable_elapsed() < self.budget
    }

    pub fn budget(&self) -> Duration {
        self.budget
    }
}

/// Cumulative time this process has held throttled groups under `SIGSTOP`.
/// Zero when nothing is throttling, which makes every [`RunnableDeadline`]
/// degrade to a plain wall-clock deadline.
pub fn total_stopped_time() -> Duration {
    let Some(gov) = governor() else {
        return Duration::ZERO;
    };
    match gov.lock() {
        Ok(g) => g.total_stopped_time(),
        Err(poisoned) => poisoned.into_inner().total_stopped_time(),
    }
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

    pub fn target_cores(&self) -> f64 {
        self.target_cores
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

/// Cumulative CPU time consumed by a set of process groups, **per process**.
///
/// Per-process rather than a single total on purpose. `ps` only reports live
/// processes, so a summed total silently loses the accumulated CPU of any
/// descendant that exits between samples. That does not merely produce a
/// negative delta the caller can discard: when surviving siblings burn more
/// than the departed process took away, the delta stays positive but is
/// understated, and the governor lets the group run above its ceiling. Keeping
/// the counters separate lets the rate be computed only from processes
/// observed in both samples.
pub trait CpuSampler: Send + Sync + 'static {
    /// CPU seconds consumed so far, keyed by pid, for every live process in
    /// any of `pgids`. Empty when none of them has a live member left.
    fn groups_cpu_seconds(&self, pgids: &[i32]) -> HashMap<i32, f64>;
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
    /// Per-pid CPU counters from the previous sample. Only pids present in both
    /// samples contribute a delta; a pid seen for the first time contributes
    /// the CPU it accumulated during the window, and a pid that vanished
    /// contributes nothing, because its final slice is unobservable.
    last_cpu_seconds: HashMap<i32, f64>,
    /// Per-pid CPU consumed in the previous window. Credited on behalf of a pid
    /// that vanishes, whose final counter is unobservable — see `sample`.
    last_delta: HashMap<i32, f64>,
    /// Whether the registered groups are currently under `SIGSTOP`. Tracked so
    /// an unthrottled cycle issues no signals at all, instead of a `SIGCONT`
    /// every 200 ms to a group that was never stopped.
    stopped: bool,
    /// When the current stop window began, and how much stopped time has
    /// accumulated overall. [`RunnableDeadline`] subtracts this so a throttled
    /// command is not killed for time it was never allowed to use.
    stopped_since: Option<Instant>,
    total_stopped: Duration,
    /// Physical capacity, used only to bound a first-sighting's credited CPU —
    /// see `ingest`. Held as a field rather than read per sample so tests can
    /// pin it and assert the cap deterministically on any host.
    machine_cores: f64,
    /// Consecutive idle ticks — see the controller reset in `ingest`.
    idle_ticks: u32,
    /// Whether the last tick asked for a duty cycle rather than idling. Idle
    /// ticks resume every group and issue nothing, so the reported state has to
    /// distinguish them from an enforced cycle — see `state`.
    last_tick_cycled: bool,
    /// Rate (in cores) the registered set sustained over the last window that
    /// produced a usable delta. Reporting only — the controller keeps its own
    /// state — but it is what makes a throttling decision explicable in the
    /// log instead of something an operator has to infer from `ps`.
    last_measured_cores: f64,
}

/// A snapshot of what the governor is doing, for logging.
#[derive(Debug, Clone, PartialEq)]
pub struct GovernorState {
    pub groups: Vec<i32>,
    pub measured_cores: f64,
    pub target_cores: f64,
    pub run_fraction: f64,
    /// Whether the duty cycle is actually issuing signals, as opposed to
    /// running the groups flat out because they are under budget.
    pub throttling: bool,
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
            last_cpu_seconds: HashMap::new(),
            last_delta: HashMap::new(),
            stopped: false,
            stopped_since: None,
            total_stopped: Duration::ZERO,
            machine_cores: machine_cores(),
            idle_ticks: 0,
            last_tick_cycled: false,
            last_measured_cores: 0.0,
        }
    }

    /// Pin the physical-capacity figure. Tests only: production reads the real
    /// machine in [`Self::new`], and a test that asserts the first-sighting cap
    /// must not depend on how many cores the host running it happens to have.
    pub fn set_machine_cores(&mut self, cores: f64) {
        self.machine_cores = cores.max(1.0);
    }

    /// What the governor is currently doing — for the log line, not control.
    pub fn state(&self) -> GovernorState {
        GovernorState {
            groups: self.groups.clone(),
            measured_cores: self.last_measured_cores,
            target_cores: self.controller.target_cores(),
            run_fraction: self.controller.run_fraction(),
            // Whether signals are ACTUALLY being issued, not merely whether
            // the controller is holding a reduced fraction. When `ps` fails the
            // governor resumes everything and idles for a second with that
            // fraction untouched — reporting "throttling" there would have the
            // log assert enforcement during exactly the window where
            // enforcement is suspended.
            throttling: self.last_tick_cycled
                && !self.groups.is_empty()
                && self.controller.run_fraction() < UNTHROTTLED_FRACTION,
        }
    }

    /// Cumulative stopped time, including any window still open.
    pub fn total_stopped_time(&self) -> Duration {
        match self.stopped_since {
            Some(since) => self.total_stopped + since.elapsed(),
            None => self.total_stopped,
        }
    }

    pub fn run_fraction(&self) -> f64 {
        self.controller.run_fraction()
    }

    pub fn groups(&self) -> &[i32] {
        &self.groups
    }

    /// Are the registered groups currently stopped?
    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn register(&mut self, pgid: i32) {
        if !self.groups.contains(&pgid) {
            self.groups.push(pgid);
            // A newcomer's pids are absent from the baseline, so they naturally
            // contribute nothing this window — no need to drop the whole map.
            // But a group joining mid-stop must not stay stopped on the
            // strength of a decision made before it existed.
            if self.stopped {
                self.signaller.stop(pgid);
            }
        }
    }

    pub fn unregister(&mut self, pgid: i32) {
        if let Some(i) = self.groups.iter().position(|p| *p == pgid) {
            self.groups.remove(i);
            // A group that leaves the governor must never leave stopped.
            self.signaller.cont(pgid);
        }
    }

    /// Re-measure the whole registered set and re-tune the shared duty cycle.
    /// `elapsed` is the wall time since the previous sample.
    /// Snapshot the registered set so the caller can sample it without holding
    /// the governor lock across an external process.
    pub fn snapshot_groups(&self) -> Vec<i32> {
        self.groups.clone()
    }

    /// Convenience wrapper that samples inline. The production loop uses
    /// [`Self::snapshot_groups`] + [`Self::ingest`] instead, so a slow `ps`
    /// cannot hold the lock; tests use this.
    pub fn sample(&mut self, elapsed: Duration) -> Tick {
        if self.groups.is_empty() {
            return self.ingest(HashMap::new(), elapsed);
        }
        let now_cpu = self.sampler.groups_cpu_seconds(&self.groups);
        self.ingest(now_cpu, elapsed)
    }

    /// Fold an already-taken sample into the controller.
    pub fn ingest(&mut self, now_cpu: HashMap<i32, f64>, elapsed: Duration) -> Tick {
        if self.groups.is_empty() {
            self.last_cpu_seconds.clear();
            self.last_measured_cores = 0.0;
            self.last_tick_cycled = false;
            self.last_delta.clear();
            // Reset the duty cycle with the workload that earned it — but only
            // once the governor has been genuinely idle, not the instant the
            // last group exits. Otherwise a stream of short-lived children
            // (each realtime mutation is its own process) starts every one of
            // them from an unthrottled fraction, and since a child that lives
            // a second or two never survives long enough for a second sample
            // to produce a delta, it is never throttled at all. Holding the
            // fraction across a brief gap treats consecutive children as the
            // continuing workload they are.
            //
            // The delay still gets the behaviour the reset exists for: a
            // CPU-heavy sync must not leave the next unrelated git command
            // starting under its stale aggressive cycle.
            self.idle_ticks = self.idle_ticks.saturating_add(1);
            if self.idle_ticks >= IDLE_TICKS_BEFORE_CONTROLLER_RESET {
                self.controller = DutyCycleController::new(self.controller.target_cores());
            }
            self.resume_all();
            return Tick::Idle;
        }
        self.idle_ticks = 0;
        if now_cpu.is_empty() {
            // An empty sample does NOT prove the groups died: `ps` may have
            // failed to spawn, exited non-zero, or returned nothing parseable.
            // Going idle without resuming would then leave a live sync or git
            // group frozen under a SIGSTOP the duty cycle never lifts, and
            // repeated sampler failures would keep it that way indefinitely.
            // Resuming first is right either way — signalling a genuinely dead
            // group is a harmless ESRCH, and an idle governor has no business
            // holding anything stopped.
            self.last_cpu_seconds.clear();
            self.last_measured_cores = 0.0;
            self.last_tick_cycled = false;
            self.resume_all();
            return Tick::Idle;
        }
        let wall = elapsed.as_secs_f64();
        if !self.last_cpu_seconds.is_empty() && wall > f64::EPSILON {
            // Only pids observed in BOTH samples yield a trustworthy delta. A
            // pid seen for the first time accumulated its whole counter inside
            // this window, so it counts in full. A pid that vanished is simply
            // absent from `now_cpu` — its final slice is unobservable, and
            // crucially its departure can no longer drag the total down and
            // hide a busy sibling's work.
            //
            // "In full" needs a ceiling, though. A first sighting is USUALLY a
            // short-lived worker born inside the window, but it is also what a
            // long-lived process looks like the moment its group joins the
            // governor — a watch daemon registered after running for an hour
            // arrives carrying an hour of CPU. Crediting that to a one-second
            // window reports a rate hundreds of times the machine's capacity,
            // which pins the shared duty cycle at its floor and starves every
            // other registered group for the many damped samples it takes to
            // climb back. No process can burn more CPU in a window than the
            // machine can deliver, so that is the cap.
            //
            // The cap is on the newcomers' AGGREGATE, not on each one. Capping
            // per pid would still let ten first-sighting processes on an
            // eight-core box contribute eighty CPU-seconds to a one-second
            // window — the same physically impossible figure, just reached by a
            // different route. Scaling the whole newcomer cohort down together
            // also keeps their relative weights intact, so the per-pid deltas
            // stay usable as the exit credit for the next window.
            let first_sighting_ceiling = wall * self.machine_cores;
            let mut consumed = 0.0;
            let mut delta = HashMap::with_capacity(now_cpu.len());
            let mut newcomers: Vec<i32> = Vec::new();
            let mut newcomer_total = 0.0;
            for (pid, now) in &now_cpu {
                match self.last_cpu_seconds.get(pid) {
                    Some(prev) => {
                        let d = (now - prev).max(0.0);
                        delta.insert(*pid, d);
                        consumed += d;
                    }
                    None => {
                        let d = now.max(0.0);
                        delta.insert(*pid, d);
                        newcomers.push(*pid);
                        newcomer_total += d;
                    }
                }
            }
            if newcomer_total > first_sighting_ceiling && newcomer_total > 0.0 {
                let scale = first_sighting_ceiling / newcomer_total;
                for pid in &newcomers {
                    if let Some(d) = delta.get_mut(pid) {
                        *d *= scale;
                    }
                }
                newcomer_total = first_sighting_ceiling;
            }
            consumed += newcomer_total;
            // A pid in the previous sample but absent from this one exited
            // inside the window, taking its final counter with it. Counting it
            // as zero makes a burst of short-lived workers — git hooks, runner
            // children — invisible, and a group of them can then sit well above
            // the ceiling while a mostly-idle group leader is all the sampler
            // sees. Credit each departed pid with what it burned in its last
            // observed window: an estimate, but one that errs toward enforcing
            // the ceiling rather than quietly exceeding it.
            for pid in self.last_cpu_seconds.keys() {
                if !now_cpu.contains_key(pid) {
                    consumed += self.last_delta.get(pid).copied().unwrap_or(0.0);
                }
            }
            self.last_delta = delta;
            let measured = consumed / wall;
            self.last_measured_cores = measured;
            self.controller.observe(measured);
        }
        self.last_cpu_seconds = now_cpu;
        let (run, stop) = self.controller.cycle_split(CYCLE);
        self.last_tick_cycled = true;
        Tick::Cycle { run, stop }
    }

    /// Stop every registered group. Idempotent.
    pub fn stop_all(&mut self) {
        for pgid in &self.groups {
            self.signaller.stop(*pgid);
        }
        if !self.stopped {
            self.stopped_since = Some(Instant::now());
        }
        self.stopped = true;
    }

    /// Resume every registered group, but only when they are actually stopped —
    /// an unthrottled cycle must issue no signals at all, or a below-budget
    /// watch daemon collects five unsolicited SIGCONTs a second forever.
    pub fn resume_all(&mut self) {
        if !self.stopped {
            return;
        }
        self.force_resume_all();
    }

    /// Resume unconditionally. For shutdown and poisoned-lock paths, where the
    /// tracked state may not reflect reality and a missed SIGCONT wedges a
    /// child permanently.
    pub fn force_resume_all(&mut self) {
        for pgid in &self.groups {
            self.signaller.cont(*pgid);
        }
        if let Some(since) = self.stopped_since.take() {
            self.total_stopped += since.elapsed();
        }
        self.stopped = false;
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
            // Stopping a process group needs `killpg`. Where that does not
            // exist there is no throttle, and every consumer — `attach` and
            // `total_stopped_time` alike — must agree from this one place.
            if !cfg!(unix) {
                return None;
            }
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

/// Abandon the governor, leaving nothing stopped.
///
/// EVERY exit from [`governor_loop`] goes through here. A bare `return` from a
/// poisoned-lock branch was a real defect: if another thread panicked while
/// holding the mutex during a stop window, the children were still under
/// SIGSTOP, so their owning threads blocked forever waiting for output and
/// their `CpuThrottle` guards never dropped to resume them. Nothing else would
/// ever have sent the SIGCONT.
fn abandon_governor(shared: &SharedGovernor) {
    match shared.lock() {
        Ok(mut g) => g.force_resume_all(),
        Err(poisoned) => poisoned.into_inner().force_resume_all(),
    }
}

fn governor_loop(shared: SharedGovernor) {
    let mut last_sample = Instant::now();
    let mut elapsed = SAMPLE_INTERVAL;
    let mut reporter = ThrottleReporter::new();
    loop {
        // Resume BEFORE measuring. The previous cycle ends in its stop phase,
        // and `ps` is an unbounded external process: sampling while stopped
        // extends the advertised ~196 ms stop window by however long `ps`
        // takes, and a wedged `ps` would hold every child under SIGSTOP for as
        // long as it hangs.
        let groups = {
            let Ok(mut g) = shared.lock() else {
                abandon_governor(&shared);
                return;
            };
            g.resume_all();
            g.snapshot_groups()
        };

        // Sample with the lock RELEASED, so a slow `ps` cannot block a
        // `RunnableDeadline` check, a guard drop, or a new registration.
        let now_cpu = if groups.is_empty() {
            HashMap::new()
        } else {
            PsSampler.groups_cpu_seconds(&groups)
        };

        let (tick, state) = {
            let Ok(mut g) = shared.lock() else {
                abandon_governor(&shared);
                return;
            };
            let tick = g.ingest(now_cpu, elapsed);
            (tick, g.state())
        };
        reporter.observe(&state);

        match tick {
            Tick::Idle => std::thread::sleep(SAMPLE_INTERVAL),
            Tick::Cycle { .. } => {
                let deadline = Instant::now() + SAMPLE_INTERVAL;
                while Instant::now() < deadline {
                    let Ok(mut g) = shared.lock() else {
                        abandon_governor(&shared);
                        return;
                    };
                    let (run, stop) = g.controller.cycle_split(CYCLE);
                    if g.groups.is_empty() {
                        break;
                    }
                    // A no-op unless the groups are actually stopped, so an
                    // unthrottled cycle issues no signals at all.
                    g.resume_all();
                    drop(g);
                    std::thread::sleep(run);
                    if stop.is_zero() {
                        continue;
                    }
                    let Ok(mut g) = shared.lock() else {
                        abandon_governor(&shared);
                        return;
                    };
                    g.stop_all();
                    drop(g);
                    std::thread::sleep(stop);
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

/// How often the governor restates an ongoing throttle in the log. Transitions
/// are always reported; this only bounds the "still throttling" heartbeat.
const REPORT_INTERVAL: Duration = Duration::from_secs(60);

/// Pure decision: should the governor emit a log line now?
///
/// Split out from [`ThrottleReporter`] so the cadence is testable without a
/// clock or a log file. `prev` is `None` before anything has been reported.
pub fn should_report_throttle(prev: Option<bool>, now: bool, since_last: Duration) -> bool {
    match prev {
        // First observation is worth a line only if something is happening;
        // an app that never throttles should not open with a log entry saying
        // so, and then never speak again.
        None => now,
        // A transition either way is always news.
        Some(was) if was != now => true,
        // Steady state: restate an ongoing throttle periodically so an
        // operator reading the log can see it is still in force, but say
        // nothing at all while under budget.
        Some(_) => now && since_last >= REPORT_INTERVAL,
    }
}

/// Emits the governor's decisions to the HQ log.
///
/// The first version of this module logged nothing, which made a live
/// investigation disproportionately hard: answering "is the ceiling actually
/// being enforced right now?" meant polling `ps` for `T` states and inferring
/// the duty cycle from CPU-time deltas. The governor already knows the answer;
/// it just never said it out loud.
struct ThrottleReporter {
    last_throttling: Option<bool>,
    last_report: Instant,
}

impl ThrottleReporter {
    fn new() -> Self {
        Self {
            last_throttling: None,
            last_report: Instant::now(),
        }
    }

    fn observe(&mut self, state: &GovernorState) {
        if !should_report_throttle(
            self.last_throttling,
            state.throttling,
            self.last_report.elapsed(),
        ) {
            self.last_throttling = Some(state.throttling);
            return;
        }
        let groups = state
            .groups
            .iter()
            .map(|g| g.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let msg = if state.throttling {
            format!(
                "holding groups [{}] to {:.2} cores — measured {:.2}, running {:.0}% of each cycle",
                groups,
                state.target_cores,
                state.measured_cores,
                state.run_fraction * 100.0
            )
        } else {
            format!(
                "released groups [{}] — measured {:.2} cores, under the {:.2} ceiling",
                groups, state.measured_cores, state.target_cores
            )
        };
        crate::logfile::log("cpu-throttle", &msg);
        self.last_throttling = Some(state.throttling);
        self.last_report = Instant::now();
    }
}

/// Smallest amount of accumulated busy time an [`InProcessPacer`] will sleep
/// on. Pacing every single file would spend more time in `nanosleep` bookkeeping
/// than in work; batching into slices keeps the overhead invisible while still
/// yielding many times a second.
const PACER_SLICE: Duration = Duration::from_millis(25);

/// How long to sleep after `busy` time working, to hold an average duty cycle
/// of `duty`.
///
/// Pure so the arithmetic is testable. `duty >= 1.0` means "no pacing".
pub fn pacer_sleep_for(busy: Duration, duty: f64) -> Duration {
    if !duty.is_finite() || duty >= 1.0 {
        return Duration::ZERO;
    }
    let duty = duty.max(MIN_RUN_FRACTION);
    busy.mul_f64((1.0 / duty) - 1.0)
}

/// The duty cycle in-process work must hold to stay inside the ceiling, or
/// `None` when throttling is off.
///
/// A single thread can consume at most one core, so the fraction of the time it
/// may run IS its core budget: a 0.5-core budget means run half the time. A
/// budget of a core or more does not constrain one thread at all.
pub fn configured_in_process_duty() -> Option<f64> {
    let percent = configured_max_machine_cpu_percent()?;
    let target = target_cores(percent, machine_cores());
    if target <= 0.0 {
        return None;
    }
    Some(target.min(1.0))
}

/// Is the governor currently supervising any child group?
///
/// Cheap and lock-brief; `false` when throttling is off entirely.
pub fn governor_has_registered_groups() -> bool {
    governor()
        .and_then(|g| g.lock().ok().map(|g| !g.groups().is_empty()))
        .unwrap_or(false)
}

/// Split the budget when in-process work and governed child groups run at the
/// same time.
///
/// The governor holds ONE budget for every group it supervises, and paced
/// in-process work cannot join that duty cycle — it has no group to signal. It
/// is therefore a second, independent consumer, and left alone the two together
/// can reach twice the advertised machine-wide ceiling. Halving the in-process
/// share whenever any group is registered keeps the total inside the ceiling.
///
/// This is deliberately a conservative split rather than exact accounting:
/// the halves are not proportional to what each side is actually demanding, so
/// the pair can land under the ceiling rather than exactly on it. Under is the
/// right direction to be wrong in for a promise about CPU.
pub fn shared_in_process_duty(base: f64, groups_registered: bool) -> f64 {
    if groups_registered {
        base / 2.0
    } else {
        base
    }
}

/// Cooperative CPU pacing for work that runs *inside* the app's own process.
///
/// The duty-cycle governor cannot help here, by design: it enforces the ceiling
/// with `SIGSTOP` on a child's process group and refuses to signal the group
/// the app itself lives in, because `killpg` there would freeze the UI along
/// with the work. So HQ's one CPU-heavy in-process job — the "Preparing sync…"
/// pre-pass, which reads and SHA-256s every syncable file — ran at full speed
/// no matter what the ceiling said. On a large HQ root that is a multi-minute
/// single-core burn the operator feels and the governor never touches.
///
/// The remedy is for such a loop to pace itself. Call [`Self::tick`] once per
/// unit of work; it tracks how long the loop has actually been busy and, once
/// that reaches a slice worth sleeping on, sleeps long enough to hold the
/// loop's average CPU at the configured share of the machine. The work takes
/// longer in wall-clock terms, which is the intended trade: the ceiling is a
/// promise about CPU, not about latency.
///
/// This is a *second* consumer of the same budget rather than a participant in
/// the shared one — it cannot join the duty cycle, since it has no group to
/// signal. In practice they do not overlap: the pre-pass runs to completion
/// before the sync runner it is measuring for is spawned.
pub struct InProcessPacer {
    duty: Option<f64>,
    busy_since: Instant,
    accumulated: Duration,
    /// Whether the governor is supervising child groups right now. A field so
    /// tests can drive the budget split without a live governor.
    groups_registered: Box<dyn Fn() -> bool + Send>,
}

impl InProcessPacer {
    /// A pacer honouring the configured machine-wide ceiling.
    pub fn new() -> Self {
        Self::with_duty(configured_in_process_duty())
    }

    /// A pacer with an explicit duty cycle. `None` disables pacing.
    pub fn with_duty(duty: Option<f64>) -> Self {
        Self::with_duty_and_groups(duty, Box::new(governor_has_registered_groups))
    }

    /// A pacer with an explicit duty cycle and an explicit answer to "is the
    /// governor supervising anything right now?". Tests use this to exercise
    /// the budget split deterministically.
    pub fn with_duty_and_groups(
        duty: Option<f64>,
        groups_registered: Box<dyn Fn() -> bool + Send>,
    ) -> Self {
        Self {
            duty: duty.filter(|d| d.is_finite() && *d < 1.0),
            busy_since: Instant::now(),
            accumulated: Duration::ZERO,
            groups_registered,
        }
    }

    /// Whether this pacer will ever sleep.
    pub fn is_pacing(&self) -> bool {
        self.duty.is_some()
    }

    /// Charge an explicitly measured amount of busy time, sleeping once enough
    /// has accumulated to be worth a pause.
    ///
    /// Preferred over [`Self::tick`] when only *part* of a loop is expensive.
    /// The sync pre-pass is the motivating case: it walks a very large tree but
    /// only a handful of files actually need reading and hashing. Charging the
    /// hashing alone paces the cost that matters and leaves the cheap
    /// `stat`-only walk running at full speed — pacing the whole walk would
    /// stretch a twenty-second traversal into several minutes to save CPU that
    /// was never being spent.
    pub fn charge(&mut self, busy: Duration) {
        let Some(duty) = self.duty else {
            return;
        };
        self.accumulated += busy;
        if self.accumulated < PACER_SLICE {
            return;
        }
        // Re-read the shared state each time rather than fixing the duty at
        // construction: a governed group can register or exit at any point
        // during a long walk, and the split has to follow it.
        let effective = shared_in_process_duty(duty, (self.groups_registered)());
        let sleep = pacer_sleep_for(self.accumulated, effective);
        self.accumulated = Duration::ZERO;
        if !sleep.is_zero() {
            std::thread::sleep(sleep);
        }
        // Restart the busy window *after* sleeping, so the pause is not itself
        // counted as work and immediately repaid with another pause.
        self.busy_since = Instant::now();
    }

    /// Account for the wall time since the last tick, sleeping if the loop has
    /// earned a pause. For loops whose every iteration is expensive; use
    /// [`Self::charge`] when only part of the iteration is.
    pub fn tick(&mut self) {
        let now = Instant::now();
        let busy = now.saturating_duration_since(self.busy_since);
        self.busy_since = now;
        self.charge(busy);
    }
}

impl Default for InProcessPacer {
    fn default() -> Self {
        Self::new()
    }
}

/// Samples cumulative group CPU with one `ps` call. `ps` is used rather than
/// libproc FFI because the whole point of this module is to *reduce* load: one
/// short-lived `ps` per second is a rounding error next to what it saves, and it
/// keeps the sampler auditable.
pub struct PsSampler;

impl CpuSampler for PsSampler {
    fn groups_cpu_seconds(&self, pgids: &[i32]) -> HashMap<i32, f64> {
        let Ok(out) = std::process::Command::new("ps")
            .args(["-A", "-o", "pgid=,pid=,time="])
            .output()
        else {
            return HashMap::new();
        };
        if !out.status.success() {
            return HashMap::new();
        }
        group_member_cpu_seconds(&String::from_utf8_lossy(&out.stdout), pgids)
    }
}

/// CPU time per pid for every row whose pgid is in `pgids`. Empty when no row
/// is, which is how a fully dead set is reported.
///
/// Per-pid rather than a running total so a member that exits between samples
/// cannot subtract its accumulated CPU from the aggregate and mask a busy
/// sibling — see [`CpuSampler`].
pub fn group_member_cpu_seconds(ps_stdout: &str, pgids: &[i32]) -> HashMap<i32, f64> {
    let mut out = HashMap::new();
    for line in ps_stdout.lines() {
        let mut parts = line.split_whitespace();
        let (Some(pg), Some(pid), Some(time)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(pg), Ok(pid)) = (pg.parse::<i32>(), pid.parse::<i32>()) else {
            continue;
        };
        if !pgids.contains(&pg) {
            continue;
        }
        if let Some(secs) = parse_ps_time(time) {
            out.insert(pid, secs);
        }
    }
    out
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

    /// Replays scripted per-pid samples and records the pgid set it was asked
    /// about. An empty map means "the whole registered set is gone".
    struct ScriptedSampler {
        script: Mutex<Vec<HashMap<i32, f64>>>,
        asked: Mutex<Vec<Vec<i32>>>,
        calls: AtomicUsize,
    }

    impl ScriptedSampler {
        fn new(script: Vec<HashMap<i32, f64>>) -> Self {
            Self {
                script: Mutex::new(script),
                asked: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            }
        }
    }

    impl CpuSampler for ScriptedSampler {
        fn groups_cpu_seconds(&self, pgids: &[i32]) -> HashMap<i32, f64> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.asked.lock().unwrap().push(pgids.to_vec());
            let mut s = self.script.lock().unwrap();
            if s.is_empty() {
                HashMap::new()
            } else {
                s.remove(0)
            }
        }
    }

    /// One sample containing a single process that has consumed `secs`.
    fn one(pid: i32, secs: f64) -> HashMap<i32, f64> {
        HashMap::from([(pid, secs)])
    }

    fn governor(
        target: f64,
        script: Vec<HashMap<i32, f64>>,
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

    // --- first-sighting credit cap ------------------------------------------

    /// A long-lived process whose group registers late arrives at its first
    /// sample carrying every second of CPU it has ever used. Crediting that to
    /// one window reports a rate the machine cannot physically produce, and the
    /// controller then pins the shared duty cycle at its floor — punishing every
    /// other registered group for an accounting artefact.
    #[test]
    fn first_sighting_cannot_credit_more_cpu_than_the_machine_can_deliver() {
        // pid 42 shows up already holding an hour of CPU.
        let (mut g, _sig) = governor(0.5, vec![one(42, 3600.0), one(42, 3600.1)]);
        g.set_machine_cores(8.0);
        g.register(100);

        // First sample only establishes a baseline — no delta yet.
        g.sample(Duration::from_secs(1));
        // Second sample: pid 42 was seen before, so the delta is the honest
        // 0.1s. The cap matters for the sample where it FIRST appears, which is
        // exercised below with a mid-run joiner.
        g.sample(Duration::from_secs(1));
        assert!(g.state().measured_cores < 8.0);
    }

    #[test]
    fn a_group_joining_mid_run_does_not_slam_the_duty_cycle_to_the_floor() {
        // pid 1 is a modest, already-tracked worker. pid 2 is a watch daemon
        // that has been running for an hour and only now joins the governor.
        let script = vec![
            HashMap::from([(1, 10.0)]),
            HashMap::from([(1, 10.2), (2, 3600.0)]),
        ];
        let (mut g, _sig) = governor(0.5, script);
        g.set_machine_cores(4.0);
        g.register(100);

        g.sample(Duration::from_secs(1)); // baseline
        g.sample(Duration::from_secs(1)); // pid 2's first sighting

        // Uncapped this would report 3600.2 cores on a 4-core box. Capped, the
        // worst it can claim is the whole machine for the whole window, plus
        // pid 1's honest delta.
        assert!(
            g.state().measured_cores <= 4.0 + 0.3,
            "measured {} cores on a 4-core machine",
            g.state().measured_cores
        );
        // And the duty cycle lands somewhere sane rather than at the floor.
        assert!(
            g.run_fraction() > MIN_RUN_FRACTION,
            "run fraction {} pinned to the floor by an accounting artefact",
            g.run_fraction()
        );
    }

    #[test]
    fn a_genuinely_new_short_lived_worker_is_still_credited_in_full() {
        // The cap must not blind the governor to a burst of real short-lived
        // children — the case the per-pid accounting exists for.
        let script = vec![
            HashMap::from([(1, 1.0)]),
            HashMap::from([(1, 1.0), (2, 0.9), (3, 0.9)]),
        ];
        let (mut g, _sig) = governor(0.5, script);
        g.set_machine_cores(8.0);
        g.register(100);

        g.sample(Duration::from_secs(1));
        g.sample(Duration::from_secs(1));

        // 1.8 cores of genuinely new work is well under the 8-core cap, so it
        // is credited in full and the controller reacts to it.
        assert!((g.state().measured_cores - 1.8).abs() < 0.01);
        assert!(g.run_fraction() < 1.0);
    }

    #[test]
    fn many_late_joiners_cannot_together_exceed_machine_capacity() {
        // Capping each newcomer separately still lets ten first sightings on an
        // eight-core box claim eighty CPU-seconds in a one-second window — the
        // same impossible figure by another route. The cohort is capped as a
        // whole.
        let mut late = HashMap::from([(1, 1.0)]);
        for pid in 10..20 {
            late.insert(pid, 3600.0);
        }
        let script = vec![HashMap::from([(1, 1.0)]), late];
        let (mut g, _sig) = governor(0.5, script);
        g.set_machine_cores(8.0);
        g.register(100);

        g.sample(Duration::from_secs(1)); // baseline
        g.sample(Duration::from_secs(1)); // ten hour-old joiners at once

        assert!(
            g.state().measured_cores <= 8.0 + 0.01,
            "ten newcomers reported {} cores on an 8-core machine",
            g.state().measured_cores
        );
    }

    #[test]
    fn scaling_a_newcomer_cohort_keeps_their_relative_weights() {
        // The per-pid deltas double as next window's exit credit, so scaling
        // must be proportional rather than truncating.
        let script = vec![
            HashMap::from([(1, 1.0)]),
            HashMap::from([(1, 1.0), (10, 300.0), (11, 100.0)]),
        ];
        let (mut g, _sig) = governor(0.5, script);
        g.set_machine_cores(2.0);
        g.register(100);
        g.sample(Duration::from_secs(1));
        g.sample(Duration::from_secs(1));

        // 400s of newcomer claim scaled down to a 2-core window, 3:1 preserved.
        let d = &g.last_delta;
        assert!((d[&10] / d[&11] - 3.0).abs() < 0.01, "weights: {d:?}");
        assert!((d[&10] + d[&11] - 2.0).abs() < 0.01, "total: {d:?}");
    }

    // --- reported state vs. what is actually enforced -----------------------

    #[test]
    fn a_sampler_failure_is_not_reported_as_enforcement() {
        // REGRESSION: `ps` failing resumes every group and idles for a second
        // without issuing a single signal, but the controller keeps its reduced
        // fraction. Reporting "throttling" there would have the log assert
        // enforcement during exactly the window enforcement is suspended.
        let script = vec![
            HashMap::from([(1, 0.0)]),
            HashMap::from([(1, 8.0)]), // way over budget → controller clamps
            HashMap::new(),            // sampler comes back empty
        ];
        let (mut g, _sig) = governor(0.5, script);
        g.register(100);

        g.sample(Duration::from_secs(1));
        g.sample(Duration::from_secs(1));
        assert!(g.state().throttling, "over budget and cycling");

        assert_eq!(g.sample(Duration::from_secs(1)), Tick::Idle);
        assert!(
            !g.state().throttling,
            "an idle tick issues no signals, so it must not claim enforcement"
        );
        assert!(
            g.run_fraction() < UNTHROTTLED_FRACTION,
            "the controller should still be holding its reduced fraction",
        );
    }

    // --- short-lived children keep the earned duty cycle --------------------

    #[test]
    fn a_burst_of_short_lived_children_is_not_each_started_unthrottled() {
        // Every realtime mutation is its own process. A child that lives a
        // second or two never survives long enough for a second sample to
        // produce a delta, so if the controller reset the instant the previous
        // one exited, none of them would ever be throttled.
        let script = vec![
            HashMap::from([(1, 0.0)]),
            HashMap::from([(1, 8.0)]), // heavy: earns a tight duty cycle
            HashMap::new(),            // that child exits
        ];
        let (mut g, _sig) = governor(0.5, script);
        g.register(100);
        g.sample(Duration::from_secs(1));
        g.sample(Duration::from_secs(1));
        let earned = g.run_fraction();
        assert!(
            earned < UNTHROTTLED_FRACTION,
            "workload should be throttled"
        );

        g.unregister(100);
        g.sample(Duration::from_secs(1)); // one idle tick — a gap, not quiet

        assert!(
            (g.run_fraction() - earned).abs() < f64::EPSILON,
            "a one-tick gap must not forget the duty cycle: {} vs {earned}",
            g.run_fraction()
        );
    }

    #[test]
    fn sustained_quiet_still_forgets_a_stale_aggressive_cycle() {
        // The reset exists so a CPU-heavy sync does not leave the next
        // unrelated git command starting under its tight cycle. Delaying it
        // must not remove it.
        let script = vec![HashMap::from([(1, 0.0)]), HashMap::from([(1, 8.0)])];
        let (mut g, _sig) = governor(0.5, script);
        g.register(100);
        g.sample(Duration::from_secs(1));
        g.sample(Duration::from_secs(1));
        assert!(g.run_fraction() < UNTHROTTLED_FRACTION);

        g.unregister(100);
        for _ in 0..IDLE_TICKS_BEFORE_CONTROLLER_RESET {
            g.sample(Duration::from_secs(1));
        }
        assert_eq!(
            g.run_fraction(),
            1.0,
            "sustained quiet must hand the next workload a clean slate"
        );
    }

    // --- sharing the budget with governed groups ----------------------------

    #[test]
    fn in_process_work_halves_its_share_while_groups_are_governed() {
        // The governor holds ONE budget for its groups and paced in-process
        // work cannot join that duty cycle, so unsplit the two together reach
        // twice the advertised ceiling.
        assert_eq!(shared_in_process_duty(0.5, false), 0.5);
        assert_eq!(shared_in_process_duty(0.5, true), 0.25);
    }

    #[test]
    fn the_split_follows_groups_registering_mid_walk() {
        use std::sync::atomic::AtomicBool;
        let governed = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&governed);
        let mut pacer = InProcessPacer::with_duty_and_groups(
            Some(0.5),
            Box::new(move || flag.load(Ordering::Relaxed)),
        );

        // Ungoverned: one slice of work at a 50% duty owes about one slice.
        let started = Instant::now();
        pacer.charge(PACER_SLICE);
        let alone = started.elapsed();

        // A group registers mid-walk: the in-process share halves, so the same
        // slice of work now owes about three.
        governed.store(true, Ordering::Relaxed);
        let started = Instant::now();
        pacer.charge(PACER_SLICE);
        let shared = started.elapsed();

        assert!(
            shared > alone,
            "sharing the ceiling must slow in-process work further: {alone:?} then {shared:?}"
        );
    }

    // --- reporting cadence --------------------------------------------------

    #[test]
    fn nothing_is_reported_until_something_is_actually_throttled() {
        assert!(!should_report_throttle(None, false, Duration::ZERO));
        assert!(should_report_throttle(None, true, Duration::ZERO));
    }

    #[test]
    fn both_directions_of_a_transition_are_reported_immediately() {
        assert!(should_report_throttle(Some(false), true, Duration::ZERO));
        assert!(should_report_throttle(Some(true), false, Duration::ZERO));
    }

    #[test]
    fn an_ongoing_throttle_is_restated_only_on_the_heartbeat() {
        assert!(!should_report_throttle(
            Some(true),
            true,
            REPORT_INTERVAL - Duration::from_secs(1)
        ));
        assert!(should_report_throttle(Some(true), true, REPORT_INTERVAL));
    }

    #[test]
    fn staying_under_budget_is_never_restated() {
        assert!(!should_report_throttle(
            Some(false),
            false,
            REPORT_INTERVAL * 100
        ));
    }

    #[test]
    fn state_reports_throttling_only_when_signals_are_actually_issued() {
        // Driven through real ticks: the flag means "signals are going out
        // right now", so a controller fraction set without a cycling tick — as
        // happens when the sampler fails — must not read as enforcement.
        let script = vec![HashMap::from([(1, 0.0)]), HashMap::from([(1, 8.0)])];
        let (mut g, _sig) = governor(0.5, script);
        assert!(!g.state().throttling, "nothing registered");
        g.register(100);
        g.sample(Duration::from_secs(1)); // baseline only
        assert!(!g.state().throttling, "registered but under budget");
        g.sample(Duration::from_secs(1)); // 8 cores against a 0.5 budget
        assert!(g.state().throttling, "over budget and cycling");
    }

    // --- in-process pacer ---------------------------------------------------

    #[test]
    fn pacing_sleeps_long_enough_to_hold_the_duty_cycle() {
        // Half the time working means an equal amount sleeping.
        assert_eq!(
            pacer_sleep_for(Duration::from_millis(100), 0.5),
            Duration::from_millis(100)
        );
        // A tenth of the time working means nine times as long asleep.
        assert_eq!(
            pacer_sleep_for(Duration::from_millis(100), 0.1),
            Duration::from_millis(900)
        );
    }

    #[test]
    fn a_budget_of_a_whole_core_does_not_pace_a_single_thread() {
        // One thread cannot exceed one core, so there is nothing to hold back.
        assert_eq!(
            pacer_sleep_for(Duration::from_millis(100), 1.0),
            Duration::ZERO
        );
        assert_eq!(
            pacer_sleep_for(Duration::from_millis(100), 4.0),
            Duration::ZERO
        );
    }

    #[test]
    fn pacing_never_freezes_a_loop_outright() {
        // A pathological duty is clamped to the same floor the duty cycle uses,
        // so a paced loop always makes progress.
        let at_floor = pacer_sleep_for(Duration::from_millis(100), MIN_RUN_FRACTION);
        assert_eq!(pacer_sleep_for(Duration::from_millis(100), 0.0), at_floor);
        assert_eq!(pacer_sleep_for(Duration::from_millis(100), -5.0), at_floor);
        assert_eq!(
            pacer_sleep_for(Duration::from_millis(100), f64::NAN),
            Duration::ZERO
        );
    }

    #[test]
    fn small_charges_accumulate_before_any_sleep_happens() {
        let mut pacer = InProcessPacer::with_duty(Some(0.5));
        let started = Instant::now();
        // Well under one slice: must not sleep, or a hot loop would spend all
        // its time in nanosleep bookkeeping.
        for _ in 0..5 {
            pacer.charge(Duration::from_millis(1));
        }
        assert!(started.elapsed() < Duration::from_millis(20));
    }

    #[test]
    fn a_full_slice_of_work_earns_a_proportional_pause() {
        let mut pacer = InProcessPacer::with_duty(Some(0.5));
        let started = Instant::now();
        pacer.charge(PACER_SLICE);
        // At a 50% duty cycle, one slice of work owes one slice of sleep.
        assert!(
            started.elapsed() >= PACER_SLICE,
            "charged a full slice but did not pause"
        );
    }

    #[test]
    fn a_disabled_pacer_never_sleeps() {
        let mut pacer = InProcessPacer::with_duty(None);
        assert!(!pacer.is_pacing());
        let started = Instant::now();
        pacer.charge(Duration::from_secs(10));
        assert!(started.elapsed() < Duration::from_millis(20));
    }

    #[test]
    fn a_budget_of_a_whole_core_disables_the_pacer_entirely() {
        // `with_duty` drops any duty that cannot constrain one thread, so the
        // hot loop pays nothing — not even the accumulate-and-compare.
        assert!(!InProcessPacer::with_duty(Some(1.0)).is_pacing());
        assert!(!InProcessPacer::with_duty(Some(2.5)).is_pacing());
        assert!(InProcessPacer::with_duty(Some(0.25)).is_pacing());
    }

    // --- config parsing ----------------------------------------------------

    #[test]
    fn default_ceiling_is_five_percent_of_the_machine() {
        assert_eq!(DEFAULT_MAX_MACHINE_CPU_PERCENT, 5.0);
        assert_eq!(parse_max_machine_cpu_percent(""), Some(5.0));
    }

    #[test]
    fn ceiling_is_a_share_of_the_whole_machine_not_one_core() {
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

    #[test]
    fn non_finite_limits_are_malformed_not_an_off_switch() {
        // `NaN` and `inf` parse successfully, so they used to fall through to
        // the zero/negative arm and silently disable the ceiling entirely.
        for raw in ["NaN", "nan", "inf", "-inf", "infinity"] {
            assert_eq!(parse_max_machine_cpu_percent(raw), Some(5.0), "raw={raw}");
        }
    }

    // --- timeout scaling ---------------------------------------------------

    #[test]
    fn a_deadline_does_not_count_time_spent_stopped() {
        // The whole point: a throttled command must not be killed for time it
        // was never allowed to use. With nothing throttling, total_stopped_time
        // is zero and this degrades to a plain wall-clock deadline.
        let d = RunnableDeadline::start(Duration::from_secs(3600));
        assert!(!d.expired());
        assert!(d.runnable_elapsed() < Duration::from_secs(1));
        assert_eq!(d.budget(), Duration::from_secs(3600));
    }

    #[test]
    fn a_zero_budget_deadline_is_immediately_expired() {
        assert!(RunnableDeadline::start(Duration::ZERO).expired());
    }

    #[test]
    fn a_wall_clock_backstop_still_catches_a_cpu_bound_wedge() {
        // Runnable-time accounting alone cannot see this: the governor keeps
        // stopping a spinning wedge exactly as it stops healthy work, and every
        // stop window is credited back, so the deadline would never arrive.
        let d = RunnableDeadline::start(Duration::from_secs(120));
        assert_eq!(d.wall_backstop(), Duration::from_secs(120 * 8));
        assert!(d.wall_backstop() > d.budget());
    }

    #[test]
    fn a_mark_measures_a_window_not_the_whole_process() {
        // The stopped-time counter is cumulative, so a mark has to snapshot it
        // at both ends; reading only the total would charge a fresh mark for
        // every stop window that came before it.
        let m = RunnableMark::now();
        assert!(m.wall_elapsed() < Duration::from_secs(1));
        assert!(m.runnable_elapsed() <= m.wall_elapsed());
    }

    #[test]
    fn stopped_time_accumulates_across_windows_and_closes_on_resume() {
        let (mut g, _sig) = governor(0.5, vec![]);
        g.register(100);
        assert_eq!(g.total_stopped_time(), Duration::ZERO);
        g.stop_all();
        // An open window already counts, or a deadline checked mid-stop would
        // charge the child for time it is not being given.
        assert!(g.total_stopped_time() >= Duration::ZERO);
        g.resume_all();
        let after_first = g.total_stopped_time();
        g.stop_all();
        g.resume_all();
        assert!(g.total_stopped_time() >= after_first);
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
            measured = demand * f;
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
        // Two groups, 0.5-core budget between them, 2.0 cores burned together.
        // A per-group budget would see 1.0 each and wrongly allow it.
        let (mut g, _sig) = governor(
            0.5,
            vec![
                HashMap::from([(1, 0.0), (2, 0.0)]),
                HashMap::from([(1, 1.0), (2, 1.0)]),
            ],
        );
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
        let (mut g, sig) = governor(0.5, vec![one(1, 0.0), one(1, 4.0)]);
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
        // Demand stays at 1 core throughout, so any change in the fraction is
        // the membership change talking, not a lull.
        let (mut g, _sig) = governor(0.5, vec![one(1, 0.0), one(1, 1.0), one(1, 2.0)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        let solo = g.run_fraction();
        assert!(solo < 1.0, "the solo group should already be throttled");
        g.register(200);
        assert_eq!(g.groups(), &[100, 200]);
        // The newcomer joining must tighten the share, never loosen it: the
        // budget is for the set, not per group.
        g.sample(SAMPLE_INTERVAL);
        assert!(
            g.run_fraction() <= solo,
            "a joining group loosened the shared ceiling: {} > {solo}",
            g.run_fraction()
        );
    }

    #[test]
    fn a_group_joining_during_a_stop_window_is_stopped_too() {
        // Otherwise a newcomer runs unthrottled until the next stop, quietly
        // exceeding the shared ceiling.
        let (mut g, sig) = governor(0.5, vec![]);
        g.register(100);
        g.stop_all();
        g.register(200);
        assert_eq!(*sig.stops.lock().unwrap(), vec![100, 200]);
    }

    #[test]
    fn a_newly_seen_process_counts_its_whole_counter_once() {
        // A worker that appears mid-window accumulated all of its CPU inside
        // that window, so ignoring it would under-measure the group.
        let (mut g, _sig) = governor(
            0.5,
            vec![one(1, 10.0), HashMap::from([(1, 10.0), (2, 4.0)])],
        );
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert!(
            g.run_fraction() < 1.0,
            "a brand-new busy worker was not counted"
        );
    }

    #[test]
    fn an_exiting_member_cannot_mask_a_busy_sibling() {
        // The regression: pid 1 leaves having burned 5s while pid 2 adds 6s.
        // A summed total moves 10 -> 11 and reports 1 core; per-pid accounting
        // sees pid 2's real 6 cores and throttles.
        let (mut g, _sig) = governor(
            0.5,
            vec![
                HashMap::from([(1, 5.0), (2, 5.0)]),
                HashMap::from([(2, 11.0)]),
            ],
        );
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        // Per-pid accounting sees pid 2's real 6 cores against a 0.5 budget.
        // A summed total would have seen 10 -> 11, called it 1 core, and left
        // the fraction at 0.75 after the same single damped step.
        assert!(
            g.run_fraction() < 0.6,
            "exiting member masked a busy sibling: fraction {}",
            g.run_fraction()
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
        let (mut g, _sig) = governor(0.5, vec![one(1, 1.0)]);
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        assert_eq!(g.sampler.calls.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn a_fully_dead_set_goes_idle_without_steering() {
        let (mut g, _sig) = governor(0.5, vec![HashMap::new()]);
        g.register(100);
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        assert_eq!(g.run_fraction(), 1.0);
    }

    #[test]
    fn ingest_folds_a_sample_taken_outside_the_lock() {
        // The production loop snapshots the group set, releases the governor
        // lock, runs `ps`, then folds the result back — so a slow or wedged
        // `ps` cannot hold every child under SIGSTOP or block a deadline check.
        let (mut g, _sig) = governor(0.5, vec![]);
        g.register(100);
        assert_eq!(g.snapshot_groups(), vec![100]);
        g.ingest(one(1, 0.0), SAMPLE_INTERVAL);
        let tick = g.ingest(one(1, 4.0), SAMPLE_INTERVAL);
        assert!(matches!(tick, Tick::Cycle { .. }));
        assert!(g.run_fraction() < 1.0);
        assert_eq!(
            g.sampler.calls.load(Ordering::Relaxed),
            0,
            "ingest must not sample"
        );
    }

    #[test]
    fn a_failed_sample_resumes_rather_than_leaving_a_group_frozen() {
        // An empty sample does not prove the group died — `ps` may simply have
        // failed. Landing there right after a stop window used to go idle with
        // the group still under SIGSTOP, and repeated failures kept it frozen.
        let (mut g, sig) = governor(0.5, vec![HashMap::new()]);
        g.register(100);
        g.stop_all();
        assert!(g.is_stopped());
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        assert_eq!(*sig.conts.lock().unwrap(), vec![100]);
        assert!(!g.is_stopped());
    }

    #[test]
    fn a_platform_that_cannot_throttle_reports_no_stopped_time() {
        // Where there is no governor nothing is ever stopped, so every
        // RunnableDeadline is a plain wall-clock deadline and an unthrottled
        // build keeps exactly the timeouts it had before this change.
        if crate::cpu_throttle::governor().is_none() {
            assert_eq!(total_stopped_time(), Duration::ZERO);
        }
    }

    #[test]
    fn a_worker_that_exits_between_samples_still_counts() {
        // pid 2 burns 4 cores in a window and exits. Counting it as zero makes
        // bursts of short-lived workers invisible while a mostly-idle group
        // leader is all the sampler sees, and the group sits above its ceiling.
        let (mut g, _sig) = governor(
            0.5,
            vec![
                HashMap::from([(1, 0.0), (2, 0.0)]),
                HashMap::from([(1, 0.01), (2, 4.0)]),
                HashMap::from([(1, 0.02)]),
            ],
        );
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        let with_worker = g.run_fraction();
        assert!(with_worker < 1.0);
        // pid 2 is gone now; its last window's 4 cores are still credited, so
        // the controller does not immediately relax as if the group went quiet.
        g.sample(SAMPLE_INTERVAL);
        assert!(
            g.run_fraction() <= with_worker,
            "an exiting worker's CPU vanished: {} > {with_worker}",
            g.run_fraction()
        );
    }

    #[test]
    fn going_idle_resets_the_duty_cycle_for_the_next_workload() {
        // Otherwise a CPU-heavy sync leaves the fraction near its floor and the
        // next unrelated git command starts under that stale aggressive cycle.
        //
        // The reset now waits for SUSTAINED quiet rather than firing on the
        // first idle tick, so that a burst of short-lived children — each
        // realtime mutation is its own process — is treated as one continuing
        // workload instead of resetting between every pair. The guarantee this
        // test exists for is unchanged, only its timing.
        let (mut g, _sig) = governor(0.5, vec![one(1, 0.0), one(1, 8.0)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert!(
            g.run_fraction() < 1.0,
            "expected the heavy pass to throttle"
        );
        g.unregister(100);
        for _ in 0..IDLE_TICKS_BEFORE_CONTROLLER_RESET {
            assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
        }
        assert_eq!(
            g.run_fraction(),
            1.0,
            "a new workload inherited the previous one's stop cycle"
        );
    }

    #[test]
    fn cpu_rate_is_derived_from_the_delta_not_the_total() {
        // 10s accumulated then 10.5s a second later is 0.5 cores — exactly the
        // budget, so no throttling.
        let (mut g, _sig) = governor(0.5, vec![one(1, 10.0), one(1, 10.5)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(g.run_fraction(), 1.0);
    }

    #[test]
    fn a_counter_that_goes_backwards_is_clamped_not_negated() {
        let (mut g, _sig) = governor(0.5, vec![one(1, 100.0), one(1, 4.0), one(1, 4.2)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(g.run_fraction(), 1.0);
        g.sample(SAMPLE_INTERVAL);
        assert_eq!(g.run_fraction(), 1.0);
    }

    // --- signalling discipline ---------------------------------------------

    #[test]
    fn an_unthrottled_group_is_never_signalled() {
        // resume_all on a group that was never stopped used to fire a SIGCONT
        // every 200ms — five a second, forever, at a persistent watch daemon.
        let (mut g, sig) = governor(0.5, vec![]);
        g.register(100);
        for _ in 0..20 {
            g.resume_all();
        }
        assert!(
            sig.conts.lock().unwrap().is_empty(),
            "signalled a group that was never stopped"
        );
    }

    #[test]
    fn a_stopped_group_is_resumed_exactly_once_per_stop() {
        let (mut g, sig) = governor(0.5, vec![]);
        g.register(100);
        g.stop_all();
        g.resume_all();
        g.resume_all();
        g.resume_all();
        assert_eq!(*sig.conts.lock().unwrap(), vec![100]);
        assert!(!g.is_stopped());
    }

    #[test]
    fn force_resume_signals_even_when_state_says_running() {
        // The shutdown and poisoned-lock paths cannot trust the tracked state:
        // a missed SIGCONT there wedges a child permanently.
        let (mut g, sig) = governor(0.5, vec![]);
        g.register(100);
        g.force_resume_all();
        assert_eq!(*sig.conts.lock().unwrap(), vec![100]);
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
    fn keeps_group_members_apart_so_an_exit_is_visible() {
        let ps = "  501  600  0:10.00\n  502  700  1:00.00\n  501  601  0:05.00\n";
        let got = group_member_cpu_seconds(ps, &[501]);
        assert_eq!(got, HashMap::from([(600, 10.0), (601, 5.0)]));
        assert_eq!(
            group_member_cpu_seconds(ps, &[501, 502]).len(),
            3,
            "every registered group's members must be reported"
        );
    }

    #[test]
    fn a_set_with_no_rows_is_reported_gone() {
        let ps = "  501  600  0:10.00\n";
        assert!(group_member_cpu_seconds(ps, &[999]).is_empty());
    }

    #[test]
    fn malformed_ps_rows_are_skipped_not_fatal() {
        let ps = "garbage\n  501  600  0:10.00\n\n  501  601  bad\n";
        assert_eq!(
            group_member_cpu_seconds(ps, &[501]),
            HashMap::from([(600, 10.0)])
        );
    }
}
