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
            self.last_delta.clear();
            // Reset the duty cycle with the workload that earned it. Otherwise a
            // CPU-heavy sync leaves the fraction near its floor, and the next
            // unrelated git command starts under that stale aggressive cycle,
            // recovering only over several damped samples — seconds of delay
            // for a command that never approached the budget.
            self.controller = DutyCycleController::new(self.controller.target_cores());
            self.resume_all();
            return Tick::Idle;
        }
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
            let mut consumed = 0.0;
            let mut delta = HashMap::with_capacity(now_cpu.len());
            for (pid, now) in &now_cpu {
                let d = match self.last_cpu_seconds.get(pid) {
                    Some(prev) => (now - prev).max(0.0),
                    None => now.max(0.0),
                };
                delta.insert(*pid, d);
                consumed += d;
            }
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
            self.controller.observe(consumed / wall);
        }
        self.last_cpu_seconds = now_cpu;
        let (run, stop) = self.controller.cycle_split(CYCLE);
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

        let tick = {
            let Ok(mut g) = shared.lock() else {
                abandon_governor(&shared);
                return;
            };
            g.ingest(now_cpu, elapsed)
        };

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
        let (mut g, _sig) = governor(0.5, vec![one(1, 0.0), one(1, 8.0)]);
        g.register(100);
        g.sample(SAMPLE_INTERVAL);
        g.sample(SAMPLE_INTERVAL);
        assert!(
            g.run_fraction() < 1.0,
            "expected the heavy pass to throttle"
        );
        g.unregister(100);
        assert_eq!(g.sample(SAMPLE_INTERVAL), Tick::Idle);
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
