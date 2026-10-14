/**
 * The event-to-scene model for "Bring in your context".
 *
 * The approved preview played a fixed script: a row per source every few
 * seconds, a trunk, a limb per company, a twig per project, a crown filling
 * in, then a settle. Here the same beats are driven by the scan's events,
 * which can arrive all at once (a fast scan) or trickle in over minutes (a
 * slow one). `planScene` turns the arrival log into a schedule of beats:
 *
 *  - Pacing. Each beat starts no earlier than the data that justifies it
 *    (plus a short lag), and no earlier than the previous beat of its kind
 *    allows: a minimum dwell between source rows, a gap between limbs and
 *    between project twigs, counters that tween instead of jumping. A fast
 *    scan therefore still plays as a staged sequence.
 *  - No running ahead. Nothing is scheduled before its event arrived, so the
 *    tree never shows a company, project or leaf the scan has not found.
 *  - Richness. How much the scan found (counts, projects, companies) maps to
 *    0..1 on a log scale with a cap, and the drawn richness follows it at a
 *    capped rate. Twigs, leaves and blossoms open as it passes their
 *    thresholds, so huge counts fill the crown and stop there.
 *  - Causality. Every beat is scheduled at or after the arrival of the event
 *    that created it, and later events only add beats at or after their own
 *    arrival. So a new event never changes anything already on screen: the
 *    scene at any second is a pure function of the events that had arrived
 *    by then.
 *
 * Times are scene seconds (the step's own clock). Pure: no clock reads.
 */

import { SCANNER_SOURCE, isScanNotRun, prettySourceId, type ScanEvent, type ScanSource } from "./scan-stream.js";
import {
  LIMB_DUR,
  MAX_COMPANY_LIMBS,
  MAX_OTHER_BRANCHES as MAX_OTHER_TWIGS,
  MAX_PROJECT_BRANCHES as MAX_PROJECT_TWIGS,
  PROJECT_DUR,
  TRUNK_DUR,
  type TreeLimbSpec,
  type TreeSpec,
} from "./tree-model.js";

export interface TimedScanEvent {
  /** Scene second the event arrived. Non-decreasing along the log. */
  at: number;
  event: ScanEvent;
}

export interface SceneInput {
  /** Scene second the person pressed "Bring it in"; null before consent. */
  scanStart: number | null;
  events: readonly TimedScanEvent[];
  /** The stream ended without its "done" line: when, and the plain message to show. */
  failure: { at: number; message: string } | null;
}

/** Pacing constants (seconds). Exported for the tests. */
export const PACE = {
  /** Every beat trails its event by at least this, so coalesced redraws never skip one. */
  lag: 0.3,
  /** The first row appears this long after "Bring it in" at the earliest. */
  firstRow: 0.35,
  /** Minimum time between two rows appearing. */
  rowDwell: 2.4,
  /** A row shows its "reading" line at least this long. */
  rowResolveMin: 1.15,
  /** The trunk starts this long after the first row. */
  trunkAfterRow: 1.35,
  /** Minimum time between two limbs starting. */
  limbGap: 0.4,
  /** A limb starts no sooner than this after the trunk. */
  limbAfterTrunk: 1.2,
  /** Minimum time between two project twigs starting. */
  projectGap: 0.36,
  /** A project twig starts no sooner than this after its limb. */
  projectAfterLimb: 0.9,
  /** The crown starts filling this long after the trunk. */
  richAfterTrunk: 1.0,
  /** Drawn richness rises at most this much per second (a full crown takes 9 s at least). */
  richRate: 1 / 9,
  /** A counter tweens to a new value over this long. */
  countTween: 2.2,
  /** Quiet after the last row before the title changes. */
  settlePad: 0.6,
} as const;

/** The scan total that fills the crown: about the preview's (546 conversations, 214 issues, 9 projects). */
export const RICHNESS_FULL_TOTAL = 900;
/** Rows shown at most; a longer list folds the rest into the last row's status. */
export const MAX_ROWS = 6;

export type RowStatus = "done" | "skipped" | "error" | "stopped";

export interface CountSample {
  t: number;
  v: number;
}

export interface PlanRow {
  id: string;
  label: string;
  /** Scene second the row rises in. */
  appear: number;
  /** When the row swaps its "reading" line for its name and counts; null while it is reading. */
  shown: number | null;
  /** When the source finished (the spinner stops); null while it is still going. */
  resolve: number | null;
  status: RowStatus | null;
  message: string | null;
  /** Count samples per key, in key order of first arrival. */
  counts: Array<{ key: string; samples: CountSample[] }>;
}

export interface PlanProject {
  id: string;
  name: string;
  ready: number;
  /** When the twig withers because a later pass moved the project to a company limb; null while it stays. */
  gone: number | null;
}

export interface PlanLimb {
  /** Company id, or "" for the other limb. */
  id: string;
  name: string;
  slot: TreeLimbSpec["slot"];
  ready: number;
  /** Project twigs drawn on this limb, in arrival order. */
  projects: PlanProject[];
  /** Every project found for this company (or unattached), drawn or not. */
  projectTotal: number;
  /** Companies past the limb cap that share the other limb. */
  extraCompanies: number;
  /** When the limb withers (an "other" limb whose projects all moved to companies); null while it stays. */
  gone: number | null;
}

export interface SummaryItem {
  key: string;
  value: number;
  label: string;
}

export type SceneOutcome = "idle" | "running" | "done" | "empty" | "failed";

export interface ScenePlan {
  scanStart: number | null;
  outcome: SceneOutcome;
  rows: PlanRow[];
  trunk: number | null;
  limbs: PlanLimb[];
  /** Richness follower knots (t, value), piecewise linear; empty before any data. */
  richness: CountSample[];
  /** Final richness target from what is in so far, 0..1. */
  richnessTarget: number;
  /** When the title changes to "<Name> knows your world."; null until the scan is done. */
  settle: number | null;
  summary: SummaryItem[];
  report: string | null;
  /** The "done" line's summary as the CLI sent it (cleaned); null until done. */
  doneSummary: Record<string, number> | null;
  failure: { at: number; message: string } | null;
  /** The last scheduled beat (before ambient). */
  lastBeat: number;
  totals: { companies: number; projects: number; items: number };
}

const SKIPPED_MESSAGE = "Not set up on this Mac";
const ERROR_MESSAGE = "Couldn't read it";
const STOPPED_MESSAGE = "Not finished";
const EMPTY_ROW_MESSAGE = "Nothing found";

interface RowWork {
  id: string;
  label: string;
  order: number;
  firstAt: number;
  terminal: { at: number; status: Exclude<RowStatus, "stopped">; message: string | null } | null;
  errorMessage: string | null;
  firstCountAt: number | null;
  /** key → raw samples (arrival time, value) */
  raw: Map<string, Array<{ at: number; v: number }>>;
}

/** The step function richness follows, as a list of (time, target) changes. */
interface TargetChange {
  t: number;
  total: number;
}

export function richnessForTotal(total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(1, Math.log1p(total) / Math.log1p(RICHNESS_FULL_TOTAL));
}

/** Piecewise-linear follower of a step function, rising at most `rate` per second. */
function follow(changes: Array<{ t: number; target: number }>, rate: number): CountSample[] {
  const knots: CountSample[] = [];
  if (!changes.length) return knots;
  let tau = changes[0]!.t;
  let v = 0;
  let g = 0;
  knots.push({ t: tau, v: 0 });
  const advance = (until: number) => {
    if (v < g) {
      const reach = tau + (g - v) / rate;
      if (reach <= until) {
        v = g;
        knots.push({ t: reach, v });
      } else {
        v += rate * (until - tau);
        knots.push({ t: until, v });
      }
    }
    tau = until;
  };
  for (const change of changes) {
    advance(change.t);
    // a flat stretch ends here: mark it, or the next rise would be read as starting early
    if (knots[knots.length - 1]!.t < tau) knots.push({ t: tau, v });
    g = Math.max(g, change.target);
  }
  if (v < g) knots.push({ t: tau + (g - v) / rate, v: g });
  return knots;
}

/** Drawn richness at second t. */
export function richnessValue(plan: Pick<ScenePlan, "richness">, t: number): number {
  const k = plan.richness;
  if (!k.length || t <= k[0]!.t) return 0;
  for (let i = 1; i < k.length; i += 1) {
    const b = k[i]!;
    if (t <= b.t) {
      const a = k[i - 1]!;
      return b.t > a.t ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : b.v;
    }
  }
  return k[k.length - 1]!.v;
}

/** First second the drawn richness reaches `theta`; Infinity if the data in so far never gets there. */
export function richnessCrossing(plan: Pick<ScenePlan, "richness">, theta: number): number {
  const k = plan.richness;
  if (!k.length) return Infinity;
  if (theta <= 0) return k[0]!.t;
  for (let i = 1; i < k.length; i += 1) {
    const a = k[i - 1]!;
    const b = k[i]!;
    if (b.v >= theta - 1e-9) {
      if (b.v === a.v) return b.t;
      return a.t + ((theta - a.v) * (b.t - a.t)) / (b.v - a.v);
    }
  }
  return Infinity;
}

/** A counter's shown value at second t: tweens from each sample to the next, never ahead of one. */
export function countValue(samples: readonly CountSample[], t: number, tween: number = PACE.countTween): number {
  let shown = 0;
  let from = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i]!;
    if (t < s.t) break;
    const next = samples[i + 1];
    // where the counter stood when this sample arrived
    from = shown;
    const end = next && next.t < s.t + tween ? next.t : s.t + tween;
    // Ease out, so a run of milestone counts (1, 2, 5, 10, ...) reads as one
    // steady climb: each new value continues at speed instead of restarting.
    const k = Math.max(0, Math.min(1, (Math.min(t, end) - s.t) / tween));
    shown = from + (s.v - from) * (1 - (1 - k) * (1 - k));
  }
  return Math.round(shown);
}

const SUMMARY_WORDS: Record<string, [string, string]> = {
  companies: ["company", "companies"],
  projects: ["project", "projects"],
  sessions: ["conversation", "conversations"],
  conversations: ["conversation", "conversations"],
  meetings: ["meeting", "meetings"],
  issues: ["issue", "issues"],
  teams: ["team", "teams"],
  repos: ["repo", "repos"],
  repositories: ["repository", "repositories"],
  files: ["file", "files"],
  documents: ["document", "documents"],
  skills: ["skill", "skills"],
  commands: ["command", "commands"],
  hooks: ["hook", "hooks"],
  agents: ["agent", "agents"],
  policies: ["policy", "policies"],
  plans: ["plan", "plans"],
  claude_md: ["CLAUDE.md file", "CLAUDE.md files"],
  settings_fragments: ["setting", "settings"],
  mcp_servers: ["MCP server", "MCP servers"],
};


/** "412 sessions", "1 session": the word for a count key. */
export function countWord(key: string, value: number, opts: { summary?: boolean } = {}): string {
  const words = SUMMARY_WORDS[key];
  if (words) {
    if (!opts.summary && key === "sessions") return value === 1 ? "session" : "sessions";
    return value === 1 ? words[0] : words[1];
  }
  const text = key.replace(/[_-]+/g, " ");
  return value === 1 && text.endsWith("s") && !text.endsWith("ss") ? text.slice(0, -1) : text;
}

function sourceIdOf(event: ScanEvent): string | null {
  switch (event.type) {
    case "source":
      return event.id;
    case "count":
      return event.source;
    case "error":
      return event.source;
    default:
      return null;
  }
}

/**
 * Turn the arrival log into a schedule of beats. Pure and causal: the plan
 * for a log, cut at any second, schedules nothing before that second that
 * the full log does not.
 */
/**
 * `planScene` that reuses its last plan while the input has the same number of
 * lines, the same start and the same failure. The runner only ever appends
 * lines (in per-frame batches), so the count says whether anything changed;
 * a new view object carrying the same lines costs nothing.
 */
export function createPlanMemo(): (input: SceneInput) => ScenePlan {
  let last: { events: number; scanStart: number | null; failure: SceneInput["failure"]; plan: ScenePlan } | null = null;
  return (input) => {
    if (
      last &&
      last.events === input.events.length &&
      last.scanStart === input.scanStart &&
      last.failure === input.failure
    ) {
      return last.plan;
    }
    const plan = planScene(input);
    last = { events: input.events.length, scanStart: input.scanStart, failure: input.failure, plan };
    return plan;
  };
}

export function planScene(input: SceneInput): ScenePlan {
  const { scanStart, events, failure } = input;
  const empty: ScenePlan = {
    scanStart,
    outcome: "idle",
    rows: [],
    trunk: null,
    limbs: [],
    richness: [],
    richnessTarget: 0,
    settle: null,
    summary: [],
    report: null,
    doneSummary: null,
    failure: null,
    lastBeat: scanStart ?? 0,
    totals: { companies: 0, projects: 0, items: 0 },
  };
  if (scanStart === null) return empty;

  // ── sources ──────────────────────────────────────────────────────────────
  const listed: ScanSource[] = [];
  const works = new Map<string, RowWork>();
  let done: { at: number; report: string | null; summary: Record<string, number> } | null = null;
  const endAt = (): number | null => done?.at ?? failure?.at ?? null;

  const work = (id: string, at: number): RowWork => {
    let w = works.get(id);
    if (!w) {
      const known = listed.findIndex((s) => s.id === id);
      w = {
        id,
        label: known >= 0 ? listed[known]!.label : prettySourceId(id),
        order: known >= 0 ? known : 1000 + works.size,
        firstAt: at,
        terminal: null,
        errorMessage: null,
        firstCountAt: null,
        raw: new Map(),
      };
      works.set(id, w);
    }
    return w;
  };

  for (const { at, event } of events) {
    if (done) break; // nothing after "done" counts
    if (event.type === "start") {
      for (const s of event.sources) if (!listed.some((x) => x.id === s.id)) listed.push(s);
      continue;
    }
    if (event.type === "done") {
      // "report": null with zero counts means the scan did not run: that is
      // the failure the runner reports, not an empty result.
      if (isScanNotRun(event)) break;
      done = { at, report: event.report, summary: event.summary };
      continue;
    }
    const id = sourceIdOf(event);
    if (!id || id === SCANNER_SOURCE) continue;
    const w = work(id, at);
    if (event.type === "source") {
      if (event.status !== "scanning" && !w.terminal) {
        w.terminal = { at, status: event.status, message: event.message };
        if (event.counts) {
          for (const [key, v] of Object.entries(event.counts)) {
            const list = w.raw.get(key) ?? [];
            const last = list[list.length - 1];
            if (!last || last.v !== v) list.push({ at, v: Math.max(v, last?.v ?? 0) });
            w.raw.set(key, list);
          }
        }
      }
    } else if (event.type === "count") {
      if (w.terminal) continue;
      w.firstCountAt ??= at;
      const list = w.raw.get(event.key) ?? [];
      const last = list[list.length - 1];
      if (!last || event.value > last.v) list.push({ at, v: event.value });
      w.raw.set(event.key, list);
    } else if (event.type === "error") {
      w.errorMessage ??= event.message;
    }
  }
  // Listed sources that never spoke still get their row once the scan ends.
  const end = endAt();
  if (end !== null) for (const s of listed) work(s.id, end);

  // Rows in order of first activity (ties: the start line's order).
  const ordered = [...works.values()].sort((a, b) => a.firstAt - b.firstAt || a.order - b.order).slice(0, MAX_ROWS);
  const rows: PlanRow[] = [];
  let prevAppear = -Infinity;
  for (const w of ordered) {
    const appear = Math.max(w.firstAt + PACE.lag, scanStart + PACE.firstRow, prevAppear + PACE.rowDwell);
    prevAppear = appear;
    const minShown = appear + PACE.rowResolveMin;
    let resolve: number | null = null;
    let status: RowStatus | null = null;
    let message: string | null = null;
    if (w.terminal) {
      resolve = Math.max(w.terminal.at + PACE.lag, minShown);
      status = w.terminal.status;
      if (status === "skipped") message = w.terminal.message ?? SKIPPED_MESSAGE;
      if (status === "error") message = w.terminal.message ?? w.errorMessage ?? ERROR_MESSAGE;
    } else if (done) {
      resolve = Math.max(done.at + PACE.lag, minShown);
      status = w.errorMessage ? "error" : "done";
      message = w.errorMessage;
    } else if (failure) {
      resolve = Math.max(failure.at + PACE.lag, minShown);
      status = "stopped";
      message = w.errorMessage ?? STOPPED_MESSAGE;
    }
    const firstData = w.firstCountAt !== null ? w.firstCountAt + PACE.lag : null;
    const shown =
      firstData !== null && (resolve === null || firstData < resolve) ? Math.max(firstData, minShown) : resolve;
    const counts: PlanRow["counts"] = [];
    for (const [key, raw] of w.raw) {
      const samples: CountSample[] = [];
      for (const s of raw) {
        const t = Math.max(s.at + PACE.lag, shown ?? Infinity);
        if (!Number.isFinite(t)) continue;
        const last = samples[samples.length - 1];
        if (last && last.t === t) last.v = Math.max(last.v, s.v);
        else samples.push({ t, v: s.v });
      }
      counts.push({ key, samples });
    }
    if (status === "done" && !message && counts.every((c) => (c.samples[c.samples.length - 1]?.v ?? 0) === 0)) {
      message = EMPTY_ROW_MESSAGE;
    }
    rows.push({ id: w.id, label: w.label, appear, shown, resolve, status, message, counts });
  }

  // ── structure ────────────────────────────────────────────────────────────
  // The first thing worth a tree: a positive count, a company or a project.
  let firstPositive: number | null = null;
  for (const { at, event } of events) {
    if (done && at > done.at) break;
    const positive =
      (event.type === "count" && event.value > 0) ||
      event.type === "company" ||
      event.type === "project" ||
      (event.type === "source" && !!event.counts && Object.values(event.counts).some((v) => v > 0));
    if (positive) {
      firstPositive = at;
      break;
    }
  }
  // The trunk follows the first row when that row was already there; a row
  // that turns up later never moves a trunk that is already scheduled.
  const firstRow = ordered[0];
  const base =
    firstPositive !== null && firstRow && firstRow.firstAt <= firstPositive && rows[0]
      ? rows[0].appear
      : scanStart + PACE.firstRow;
  const trunk = firstPositive === null ? null : Math.max(firstPositive + PACE.lag, base + PACE.trunkAfterRow);

  const limbs: PlanLimb[] = [];
  const byCompany = new Map<string, PlanLimb>();
  const overflowCompanies = new Set<string>();
  const companyNames = new Map<string, string>();
  let other: PlanLimb | null = null;
  let prevLimbReady = -Infinity;
  let prevProjectReady = -Infinity;
  let companyCount = 0;
  let projectCount = 0;
  /** Where each project is drawn now (projects are upserted by id). */
  const placed = new Map<string, { limb: PlanLimb; company: string | null; drawn: PlanProject | null }>();
  const targetChanges: TargetChange[] = [];
  const countTotals = new Map<string, number>();
  let countSum = 0;
  let structureBonus = 0;

  const newLimb = (at: number, id: string, name: string, slot: TreeLimbSpec["slot"]): PlanLimb => {
    const ready = Math.max(at + PACE.lag, prevLimbReady + PACE.limbGap, (trunk ?? at) + PACE.limbAfterTrunk);
    prevLimbReady = ready;
    const limb: PlanLimb = { id, name, slot, ready, projects: [], projectTotal: 0, extraCompanies: 0, gone: null };
    limbs.push(limb);
    return limb;
  };
  const otherLimb = (at: number): PlanLimb => (other ??= newLimb(at, "", "Other", "other"));

  for (const { at, event } of events) {
    if (done && at > done.at) break;
    if (event.type === "company") {
      if (byCompany.has(event.id) || overflowCompanies.has(event.id)) continue;
      companyCount += 1;
      companyNames.set(event.id, event.name);
      structureBonus += 20;
      const slot = byCompany.size;
      if (slot < MAX_COMPANY_LIMBS) {
        const limb = newLimb(at, event.id, event.name, slot);
        byCompany.set(event.id, limb);
        targetChanges.push({ t: limb.ready, total: countSum + structureBonus });
      } else {
        overflowCompanies.add(event.id);
        const limb = otherLimb(at);
        limb.extraCompanies += 1;
        targetChanges.push({ t: Math.max(at + PACE.lag, limb.ready), total: countSum + structureBonus });
      }
    } else if (event.type === "project") {
      const known = placed.get(event.id);
      if (known) {
        // The same project again: a later pass attached the company it had
        // none of. Its twig withers on the old limb and grows on the
        // company's, once it has finished growing where it was.
        const dest = event.company ? byCompany.get(event.company) : undefined;
        if (!dest || dest === known.limb) continue;
        const from = known.limb;
        from.projectTotal -= 1;
        const leaving = known.drawn;
        if (leaving) leaving.gone = Math.max(at + PACE.lag, leaving.ready + PROJECT_DUR + 0.3);
        dest.projectTotal += 1;
        known.limb = dest;
        known.company = event.company;
        known.drawn = null;
        if (dest.projects.length < MAX_PROJECT_TWIGS) {
          const ready = Math.max(
            at + PACE.lag,
            prevProjectReady + PACE.projectGap,
            dest.ready + PACE.projectAfterLimb,
            leaving?.gone ?? 0,
          );
          prevProjectReady = ready;
          known.drawn = { id: event.id, name: event.name, ready, gone: null };
          dest.projects.push(known.drawn);
        }
        // An "other" limb left with nothing withers too; the next unattached
        // project grows a fresh one.
        if (from.slot === "other" && from.projectTotal <= 0 && from.extraCompanies === 0) {
          from.gone = Math.max(at + PACE.lag, ...from.projects.map((p) => (p.gone ?? 0) + 0.4), from.ready + LIMB_DUR);
          if (other === from) other = null;
        }
        continue;
      }
      projectCount += 1;
      structureBonus += 8;
      const limb = (event.company ? byCompany.get(event.company) : undefined) ?? otherLimb(at);
      limb.projectTotal += 1;
      const cap = limb.slot === "other" ? MAX_OTHER_TWIGS : MAX_PROJECT_TWIGS;
      let t = Math.max(at + PACE.lag, limb.ready);
      let drawn: PlanProject | null = null;
      if (limb.projects.length < cap) {
        const ready = Math.max(at + PACE.lag, prevProjectReady + PACE.projectGap, limb.ready + PACE.projectAfterLimb);
        prevProjectReady = ready;
        drawn = { id: event.id, name: event.name, ready, gone: null };
        limb.projects.push(drawn);
        t = ready;
      }
      placed.set(event.id, { limb, company: event.company, drawn });
      targetChanges.push({ t, total: countSum + structureBonus });
    } else if (event.type === "count" || (event.type === "source" && event.counts)) {
      const sid = event.type === "count" ? event.source : event.id;
      const row = rows.find((r) => r.id === sid);
      const pairs = event.type === "count" ? [[event.key, event.value] as const] : Object.entries(event.counts ?? {});
      let changed = false;
      for (const [key, value] of pairs) {
        const k = `${sid}\u0000${key}`;
        const prev = countTotals.get(k) ?? 0;
        if (value > prev) {
          countSum += value - prev;
          countTotals.set(k, value);
          changed = true;
        }
      }
      if (changed) {
        const t = Math.max(at + PACE.lag, row?.shown ?? at + PACE.lag);
        targetChanges.push({ t, total: countSum + structureBonus });
      }
    }
  }

  // ── richness ─────────────────────────────────────────────────────────────
  let richness: CountSample[] = [];
  const total = countSum + structureBonus;
  const richnessTarget = richnessForTotal(total);
  if (trunk !== null) {
    const floor = trunk + PACE.richAfterTrunk;
    const changes = targetChanges
      .map((c) => ({ t: Math.max(c.t, floor), target: richnessForTotal(c.total) }))
      .sort((a, b) => a.t - b.t);
    // the follower starts at the first change
    richness = follow(changes, PACE.richRate);
  }

  // ── outcome, settle, summary ─────────────────────────────────────────────
  const anyPositive = firstPositive !== null;
  let outcome: SceneOutcome = "running";
  if (done) outcome = anyPositive ? "done" : "empty";
  else if (failure) outcome = "failed";

  let lastBeat = scanStart;
  for (const r of rows) lastBeat = Math.max(lastBeat, r.appear, r.shown ?? 0, r.resolve ?? 0);
  if (trunk !== null) lastBeat = Math.max(lastBeat, trunk + TRUNK_DUR);
  for (const limb of limbs) {
    // conservative: the limb waits at most until the trunk passes its fork
    const limbStart = Math.max(limb.ready, (trunk ?? limb.ready) + TRUNK_DUR - 0.1);
    lastBeat = Math.max(lastBeat, limbStart + LIMB_DUR);
    for (const p of limb.projects) {
      lastBeat = Math.max(lastBeat, Math.max(p.ready, limbStart + LIMB_DUR) + PROJECT_DUR);
      if (p.gone !== null) lastBeat = Math.max(lastBeat, p.gone + 1);
    }
    if (limb.gone !== null) lastBeat = Math.max(lastBeat, limb.gone + 1);
  }
  const lastKnot = richness[richness.length - 1];
  if (lastKnot) lastBeat = Math.max(lastBeat, lastKnot.t + 1.4);

  let settle: number | null = null;
  if (done) settle = Math.max(done.at + PACE.lag, lastBeat + PACE.settlePad);

  const summary = done ? summaryItems(done.summary, { companies: companyCount, projects: projectCount, rows }) : [];

  return {
    scanStart,
    outcome,
    rows,
    trunk,
    limbs,
    richness,
    richnessTarget,
    settle,
    summary,
    report: done?.report ?? null,
    doneSummary: done ? { ...done.summary } : null,
    failure: done ? null : failure,
    lastBeat: settle ?? (failure ? Math.max(lastBeat, failure.at + PACE.lag) : lastBeat),
    totals: { companies: companyCount, projects: projectCount, items: countSum },
  };
}

function summaryItems(
  summary: Record<string, number>,
  found: { companies: number; projects: number; rows: PlanRow[] },
): SummaryItem[] {
  const values = new Map<string, number>(Object.entries(summary));
  if (!values.size) {
    values.set("companies", found.companies);
    values.set("projects", found.projects);
    for (const row of found.rows) {
      for (const c of row.counts) {
        const v = c.samples[c.samples.length - 1]?.v ?? 0;
        values.set(c.key, (values.get(c.key) ?? 0) + v);
      }
    }
  }
  const order = ["companies", "projects"];
  const keys = [...order.filter((k) => values.has(k)), ...[...values.keys()].filter((k) => !order.includes(k))];
  return keys
    .map((key) => ({ key, value: values.get(key) ?? 0 }))
    .filter((item) => item.value > 0)
    .slice(0, 5)
    .map((item) => ({ ...item, label: countWord(item.key, item.value, { summary: true }) }));
}

/** The tree the plan has scheduled so far. */
export function treeSpecFor(plan: ScenePlan): TreeSpec {
  return {
    trunk: plan.trunk,
    limbs: plan.limbs.map((l) => ({
      slot: l.slot,
      ready: l.ready,
      gone: l.gone,
      projects: l.projects.map((p) => ({ ready: p.ready, gone: p.gone })),
    })),
    richnessAt: (theta) => richnessCrossing(plan, theta),
  };
}

/** The row feeding the tree at second t: the latest one to have appeared. */
export function feedingRow(plan: Pick<ScenePlan, "rows">, t: number): number {
  let at = -1;
  for (let i = 0; i < plan.rows.length; i += 1) if (plan.rows[i]!.appear + 0.45 <= t) at = i;
  return at;
}
