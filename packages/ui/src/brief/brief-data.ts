/**
 * Gathers one day's `BriefInput` from the PlatformAdapter.
 *
 * Every source is optional and read independently: a missing method or a
 * failed call is logged and recorded in `failures`, and the brief still
 * renders from what did load. Nothing here mutates anything.
 *
 * Live sources today:
 * - calendar (meetings.listUpcoming) -> today's strip
 * - recorded meetings + signals (meetings.listRecorded / getRecorded /
 *   readRecordedBody) -> yesterday's meetings, open questions as decisions,
 *   action items, risks
 * - DM threads (notifications.fetchDmThreads) -> who you talked to, who you
 *   wait on
 * - local sessions (agents.listLocalSessions) -> sessions by workstream
 * - identity.whoami -> the greeting name
 * No adapter route reports shipped PRs or main CI health yet, so `shipped` and
 * incident risks stay empty unless a seed or the sweep supplies them.
 *
 * Run files (read through the same HQ file seam, never written):
 * - brief-data.json (the sweep) -> PR totals, shipped rollups, red main,
 *   fleet incident, releases, the brief's local date; see brief-sweep.ts
 * - brief.json (the writer) -> decisions, waits, incidents, watch rows,
 *   priorities, prefs, shipped notes, meetings, people, carry, handoffs,
 *   recovered, releases, reminders, the week; see brief-run-files.ts.
 *   Row-level folds happen here: a sweep red-main risk folds into the
 *   writer's decision or incident on the same repo or product, writer
 *   shipped rows merge onto the sweep rollups by product, people onto the
 *   DM team, meetings onto the sweep's by title or start.
 * - the previous ready run (index.jsonl, then its two files through the same
 *   code path) -> `previous = { runId, hashes: digest(prevInput) }` for
 *   rotation; absent or unreadable is null, never an error.
 */

import type { AdapterPromise, Json, WhoAmI } from "@hq/platform";
import { parseRecordedMeetings, signalBodyText } from "../meetings/recorded-meetings.js";
import { localSessionsFromNative } from "../telemetry/telemetry-local-sessions.js";
import { eventEnd, eventMeetingUrl, eventStart, type MeetingEvent } from "../meetings/meetings-model.js";
import { digest } from "./brief-catalogue.js";
import { isNamedShip } from "./brief-distill.js";
import { productName, repoShort } from "./brief-origin.js";
import { briefSeed } from "./brief-seed.js";
import { parseSweep, sweepToInput } from "./brief-sweep.js";
import { parseBriefItems, parseHousekeeping, type BriefHousekeeping, type BriefRunItems } from "./brief-run-files.js";
import { BRIEF_INDEX_PATH, briefRunPath, isBriefRunId, parseBriefIndex, previousReadyRun, runIdTime } from "./brief-runs.js";
import type {
  BriefActionItem,
  BriefCalendarEvent,
  BriefDecision,
  BriefInput,
  BriefMeeting,
  BriefPrevious,
  BriefRelease,
  BriefRisk,
  BriefSession,
  BriefShipped,
  BriefTeammate,
  BriefWaiting,
} from "./brief-types.js";

/** The slice of the PlatformAdapter the brief reads. Every part is optional. */
export interface BriefAdapter {
  identity?: { whoami?(): AdapterPromise<WhoAmI> } | null;
  meetings?: {
    listUpcoming?(): AdapterPromise<Json[]>;
    listRecorded?(companyId?: string | null): AdapterPromise<Json>;
    getRecorded?(meetingId: string, companyId?: string | null): AdapterPromise<Json>;
    readRecordedBody?(url: string): AdapterPromise<string>;
  } | null;
  files?: { getFileContent?(path: string): AdapterPromise<string> } | null;
  /** Live DM thread reads for the Team card. */
  messaging?: { fetchDmThread?(args: { withPersonUid: string; limit?: number }): AdapterPromise<Json> } | null;
  notifications?: { fetchDmThreads?(opts?: Json): AdapterPromise<Json> } | null;
  agents?: {
    listLocalSessions?(
      range: { from: string; to: string },
      page?: { offset?: number; limit?: number },
    ): AdapterPromise<Json>;
  } | null;
}

/**
 * Reads an HQ-root-relative text file, or resolves null when it is absent.
 * The desktop host backs it with `files.getFileContent` (the native
 * get_company_file_content command, which enforces the session read scope).
 */
export interface BriefSweepSource {
  readHqFile(relPath: string): Promise<string | null>;
}

/**
 * Where a sweep's output lives, relative to the HQ root. A run reads its own
 * folder (`workspace/brief/<run_id>/`); with no run, the older per-day folder
 * is still read so a brief made before runs existed keeps rendering.
 */
export function sweepPath(now: Date, runId?: string | null): string {
  return runId ? briefRunPath(runId, "brief-data.json") : `workspace/brief/${localDay(now)}/brief-data.json`;
}

/** A sweep source over the adapter's HQ file read, when the host has one. */
export function adapterSweepSource(files: { getFileContent?(path: string): AdapterPromise<string> } | null | undefined): BriefSweepSource | null {
  if (!files?.getFileContent) return null;
  return {
    async readHqFile(relPath) {
      const res = await files.getFileContent!(relPath);
      if (res.ok) return res.value;
      // Absent is normal (no run yet); anything else is worth a log line.
      const why = res.message ?? res.reason;
      if (!/not found/i.test(why)) console.warn(`[daily-brief] could not read ${relPath}: ${why}`);
      return null;
    },
  };
}

export interface BriefCompanyRef {
  uid: string;
  slug?: string | null;
  label: string;
}

export interface GatherOptions {
  now?: Date;
  companies: readonly BriefCompanyRef[];
  lastBriefAt?: string | null;
  /** Reads the morning sweep file when present; merged under adapter data. */
  sweep?: BriefSweepSource | null;
  /** Company the sweep's work belongs to; defaults to the first company. */
  sweepCompanyUid?: string | null;
  /**
   * The run to render. Its brief-data.json replaces the per-day sweep, and
   * its brief.json supplies decisions, waits and incidents with their prompts.
   */
  runId?: string | null;
  /**
   * The ready run before this one, whose content hashes drive rotation.
   * Omitted: found in workspace/brief/index.jsonl. null: no rotation. A run
   * id: used as given. Only read when `runId` is set.
   */
  previousRunId?: string | null;
  log?: (message: string, err?: unknown) => void;
}

export interface GatherResult {
  input: BriefInput;
  /** Sources that failed or were unavailable, by name. */
  failures: string[];
}

/** Recorded meetings read per company, and signal bodies read in total. */
export const MEETINGS_PER_COMPANY = 5;
export const BODY_READS = 30;
export const MAX_COMPANIES = 6;

export { configureBriefSeed } from "./brief-seed.js";

class SourceError extends Error {}

async function unwrap<T>(name: string, call: AdapterPromise<T> | undefined): Promise<T> {
  if (!call) throw new SourceError(`${name}: unavailable on this host`);
  const res = await call;
  if (!res.ok) throw new SourceError(`${name}: ${res.reason}${res.code ? ` (${res.code})` : ""}`);
  return res.value;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const companyIds = (companies: readonly BriefCompanyRef[]): string[] => companies.flatMap((c) => [c.uid, ...(c.slug ? [c.slug] : [])]);

/**
 * An empty day for `now`: the shape every list starts from, for the brief
 * being rendered and for the previous run whose digest it rotates against.
 */
export function baseInput(now: Date, userName: string, companies: readonly BriefCompanyRef[], lastBriefAt: string | null): BriefInput {
  return {
    now: now.toISOString(),
    userName,
    companies: companyIds(companies),
    calendarToday: [],
    meetingsYesterday: [],
    decisions: [],
    actionItems: [],
    risks: [],
    shipped: [],
    merged: null,
    opened: null,
    waitingOn: [],
    team: [],
    sessions: [],
    recentSessions: [],
    lastBriefAt,
    dmCount: 0,
    // The weekday's only source; the sweep's window.today replaces it when present.
    today: localDay(now),
  };
}

function sameLocalDay(iso: string, day: Date): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && localDay(new Date(t)) === localDay(day);
}

/** First sentence of a signal body, short enough for a card row. */
export function signalTitle(markdown: string): string {
  // Heading-only lines ("# Question") label the signal; they are not its text.
  const body = markdown.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const text = signalBodyText(body.split(/\r?\n/).filter((line) => !/^#{1,6}\s/.test(line.trim())).join("\n"));
  const first = text.split(/(?<=[.?!])\s/)[0] ?? text;
  return first.length > 90 ? `${first.slice(0, 87).trimEnd()}...` : first;
}

const LEARN = /\b(training|office hours|live session|getting started|course|workshop|class)\b/i;

/**
 * Today's calendar from the upcoming feed, read with the Meetings view's own
 * event helpers (eventStart / eventEnd / eventMeetingUrl) so times and links
 * agree. Every named event of the day is kept, with or without a join link. All-day, cancelled and declined events are
 * left out; untitled "Busy" holds are kept as busy blocks (the strip drops
 * the ones a named event covers); a repeated event (same title and start,
 * from two calendars) is kept once.
 */
export function calendarToday(raw: readonly Json[], now: Date, selfEmail: string): BriefCalendarEvent[] {
  const self = selfEmail.toLowerCase();
  const domain = self.split("@")[1] ?? "";
  const out: BriefCalendarEvent[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const e = rec(item);
    if (str(e.status) === "cancelled") continue;
    const ev = item as unknown as MeetingEvent;
    if (!rec(e.start).dateTime) continue; // all-day
    const start = eventStart(ev);
    if (!start || !sameLocalDay(start.toISOString(), now)) continue;
    const end = eventEnd(ev);
    const attendees = Array.isArray(e.attendees) ? e.attendees.map(rec) : [];
    const me = attendees.find((a) => a.self === true || (self !== "" && str(a.email).toLowerCase() === self));
    const response = str(me?.responseStatus);
    if (response === "declined") continue;
    const summary = str(e.summary);
    const busy = !summary || summary.toLowerCase() === "busy";
    const key = `${summary.toLowerCase()}|${start.getTime()}`;
    if (!busy && seen.has(key)) continue;
    seen.add(key);
    const outside =
      domain !== "" &&
      attendees.some((a) => {
        const email = str(a.email).toLowerCase();
        return email.includes("@") && !email.endsWith(`@${domain}`) && !email.endsWith("calendar.google.com");
      });
    out.push({
      id: str(e.id) || key,
      title: busy ? "Busy" : summary,
      start: start.toISOString(),
      end: end && end.getTime() > start.getTime() ? end.toISOString() : null,
      kind: LEARN.test(summary) ? "learn" : outside ? "ext" : "team",
      ...(busy ? { busy: true } : {}),
      ...(response === "tentative" ? { tentative: true } : {}),
      attendees: attendees
        .filter((a) => a !== me && a.resource !== true)
        .map((a) => str(a.displayName) || str(a.email))
        .filter(Boolean),
      joinUrl: busy ? null : eventMeetingUrl(ev),
    });
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

type SignalKind = "decisions" | "actions" | "risks" | "questions";
const SIGNAL: Record<string, SignalKind> = {
  decision: "decisions",
  decisions: "decisions",
  action: "actions",
  actions: "actions",
  action_item: "actions",
  action_items: "actions",
  actionItem: "actions",
  commitment: "actions",
  risk: "risks",
  risks: "risks",
  question: "questions",
  questions: "questions",
  open_question: "questions",
};

/** Signals in a meeting detail envelope, grouped by kind, with body urls. */
export function signalsByKind(detail: unknown): Record<SignalKind, { title: string | null; url: string | null }[]> {
  const out: Record<SignalKind, { title: string | null; url: string | null }[]> = {
    decisions: [],
    actions: [],
    risks: [],
    questions: [],
  };
  const signals = rec(rec(detail).signals);
  for (const [type, list] of Object.entries(signals)) {
    const kind = SIGNAL[type];
    if (!kind || !Array.isArray(list)) continue;
    for (const item of list) {
      const s = rec(item);
      out[kind].push({ title: str(s.title) || null, url: str(s.presigned_url) || str(s.url) || null });
    }
  }
  return out;
}

export async function gatherBriefInput(adapter: BriefAdapter, opts: GatherOptions): Promise<GatherResult> {
  const now = opts.now ?? new Date();
  const seed = briefSeed();
  if (seed) return { input: seed(), failures: [] };

  const log = opts.log ?? ((message: string, err?: unknown) => console.warn(`[daily-brief] ${message}`, err ?? ""));
  const failures: string[] = [];
  const fail = (name: string, err: unknown) => {
    failures.push(name);
    log(`${name} failed`, err instanceof Error ? err.message : err);
  };
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const companies = opts.companies.slice(0, MAX_COMPANIES);

  let selfEmail = "";
  let selfUid = "";
  let userName = "";
  try {
    const me = await unwrap("identity", adapter.identity?.whoami?.());
    selfEmail = str(me.email);
    selfUid = str(me.personUid);
    userName = str(me.displayName).split(/\s+/)[0] ?? "";
  } catch (err) {
    fail("identity", err);
  }

  const [calendar, meetings, dms, sessions] = await Promise.all([
    (async () => {
      try {
        return calendarToday(await unwrap("calendar", adapter.meetings?.listUpcoming?.()), now, selfEmail);
      } catch (err) {
        fail("calendar", err);
        return [] as BriefCalendarEvent[];
      }
    })(),
    readMeetings(adapter, companies, yesterday, fail),
    readDms(adapter, now, yesterday, selfUid, fail),
    (async () => {
      try {
        // Yesterday and today, so the sunrise timeline can cover the last 24 hours.
        const page = localSessionsFromNative(
          await unwrap(
            "sessions",
            adapter.agents?.listLocalSessions?.({ from: localDay(yesterday), to: localDay(now) }, { limit: 400 }),
          ),
        );
        // Only sessions you started; untitled shells with no company are background noise.
        return page.rows.filter(keepNativeSession).map(
          (r): BriefSession => ({
            id: r.id,
            title: r.title,
            startedAt: r.startedAt,
            workstream: r.project || r.company || "Other",
            company: r.company || null,
          }),
        );
      } catch (err) {
        fail("sessions", err);
        return [] as BriefSession[];
      }
    })(),
  ]);

  const input: BriefInput = {
    ...baseInput(now, userName, companies, opts.lastBriefAt ?? null),
    calendarToday: mergePastMeetings(calendar, meetings.todayRecorded, now),
    meetingsYesterday: meetings.meetings,
    decisions: meetings.decisions,
    actionItems: meetings.actionItems,
    risks: meetings.risks,
    waitingOn: dms.waiting,
    team: dms.team,
    sessions: sessions.filter((s) => localDay(new Date(s.startedAt)) === localDay(yesterday)),
    recentSessions: sessions.filter((s) => {
      const t = Date.parse(s.startedAt);
      return t > now.getTime() - 24 * 3600_000 && t <= now.getTime();
    }),
    dmCount: dms.count,
  };
  const sweep = opts.sweep === undefined ? adapterSweepSource(adapter.files) : opts.sweep;
  if (sweep) await mergeSweep(input, sweep, opts, now, yesterday, fail);
  if (sweep && opts.runId) {
    await mergeRunItems(input, sweep, opts, fail);
    input.runId = opts.runId;
    input.previous = opts.previousRunId === null ? null : await readPrevious(sweep, opts, now, userName, log);
    input.previousRunId = input.previous?.runId ?? null;
  }
  return { input, failures };
}

/**
 * The previous ready run's content hashes, for rotation. The run comes from
 * `opts.previousRunId` or from index.jsonl; its brief-data.json and
 * brief.json go through the same merge code as the brief being rendered,
 * then `digest()` hashes every catalogue entry. Read-only. Anything missing
 * or unreadable is null and is logged once, never recorded as a failure.
 */
async function readPrevious(
  source: BriefSweepSource,
  opts: GatherOptions,
  now: Date,
  userName: string,
  log: (message: string, err?: unknown) => void,
): Promise<BriefPrevious | null> {
  try {
    let prevId: string;
    let createdAt: string | null = null;
    let lastBriefAt: string | null = null;
    if (typeof opts.previousRunId === "string") {
      if (!isBriefRunId(opts.previousRunId) || opts.previousRunId === opts.runId) return null;
      prevId = opts.previousRunId;
    } else {
      const text = await source.readHqFile(BRIEF_INDEX_PATH);
      if (text == null) return null;
      const { entries } = parseBriefIndex(text);
      const prev = previousReadyRun(entries, opts.runId ?? null);
      if (!prev) return null;
      prevId = prev.runId;
      createdAt = prev.createdAt;
      // The run before that one set the previous brief's "days away", as it did when made.
      lastBriefAt = previousReadyRun(entries, prevId)?.createdAt ?? null;
    }
    const at = createdAt ? new Date(createdAt) : runIdTime(prevId);
    const prevNow = at && Number.isFinite(at.getTime()) ? at : now;
    const prevYesterday = new Date(prevNow);
    prevYesterday.setDate(prevYesterday.getDate() - 1);
    const problems: string[] = [];
    const soft = (name: string) => problems.push(name);
    const prevOpts: GatherOptions = { ...opts, runId: prevId, lastBriefAt };
    const prev = baseInput(prevNow, userName, opts.companies.slice(0, MAX_COMPANIES), lastBriefAt);
    await mergeSweep(prev, source, prevOpts, prevNow, prevYesterday, soft);
    await mergeRunItems(prev, source, prevOpts, soft);
    if (problems.length) {
      log(`previous brief ${prevId} is missing ${problems.join(", ")}; no rotation`);
      return null;
    }
    prev.runId = prevId;
    return { runId: prevId, hashes: digest(prev) };
  } catch (err) {
    log("previous brief unreadable; no rotation", err instanceof Error ? err.message : err);
    return null;
  }
}

/** A native session row the brief counts: your own, with a company or a title. */
export function keepNativeSession(r: { kind?: string; company?: string | null; title?: string | null }): boolean {
  return (r.kind ?? "you") === "you" && !!(r.company?.trim() || r.title?.trim());
}

/** The synthesized items win over the adapter's raw ones: they carry the run's prompts. */
async function mergeRunItems(
  input: BriefInput,
  source: BriefSweepSource,
  opts: GatherOptions,
  fail: (name: string, err: unknown) => void,
): Promise<void> {
  let text: string | null;
  try {
    text = await source.readHqFile(briefRunPath(opts.runId!, "brief.json"));
  } catch (err) {
    fail("brief.json", err);
    return;
  }
  if (text == null) {
    fail("brief.json", new SourceError("brief.json: not written"));
    return;
  }
  const items = parseBriefItems(text, opts.sweepCompanyUid ?? opts.companies[0]?.uid ?? null);
  if (!items) {
    fail("brief.json", new SourceError("brief.json: not valid JSON"));
    return;
  }
  applyRunItems(input, items);
}

/**
 * Lays the writer's items over the input. Lists the writer filled replace the
 * adapter's raw ones (they carry the run's prompts); the sweep's facts stay
 * and fold into the writer's rows where they describe the same thing.
 */
export function applyRunItems(input: BriefInput, items: BriefRunItems): void {
  if (items.today) input.today = items.today;
  if (items.leadHint) input.leadHint = items.leadHint;
  if (items.catchUp) input.catchUp = true;
  input.prefs = items.prefs;
  if (items.decisions.length) input.decisions = items.decisions;
  if (items.waiting.length) input.waitingOn = items.waiting;
  // Writer watch rows replace the raw signal risks; incidents and the sweep's red mains stay.
  const kept = items.watch.length ? input.risks.filter((r) => r.severity !== "watch") : input.risks;
  input.risks = foldMainHealth([...items.incidents, ...kept, ...items.watch], input.decisions);
  if (items.priorities.length) input.priorities = items.priorities;
  input.shipped = mergeShipped(input.shipped, items.shipped);
  if (items.people.length) input.team = mergeTeam(input.team, items.people);
  input.meetingsYesterday = mergeMeetings(input.meetingsYesterday, items.meetings);
  if (items.carry.length) input.carry = items.carry;
  if (items.handoffs.length) input.handoffs = items.handoffs;
  if (items.recovered.length) input.recovered = items.recovered;
  if (items.reminders.length) input.reminders = items.reminders;
  if (items.releases.length) input.releases = mergeReleases(input.releases ?? [], items.releases);
  if (items.days.length) input.days = items.days;
  if (items.landedDays.length) input.landedDays = items.landedDays;
  if (items.timeToClearMin != null) input.timeToClearMin = items.timeToClearMin;
  // The writer's fleet incident is the one a priority can point at.
  if (input.fleetIncident && items.fleetIncidentId) input.fleetIncident = { ...input.fleetIncident, id: items.fleetIncidentId };
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
/** "indigoai-us/hq-core" and "hq-core" are the same repo. */
const repoKey = (repo: string | null | undefined) => lower(repoShort(repo));
/** The product an origin names, lowercased; "" when it names nothing. */
const productKey = (repo: string | null | undefined, product: string | null | undefined) => lower(productName(repo, product));
/** A red-main risk the sweep made (`ci:<repo>`), as opposed to one the writer wrote. */
const isSweepCi = (r: BriefRisk) => r.id.startsWith("ci:") && !!r.ci;
/** "hq-cloud" or "org/hq-cloud"; a product name or a title is not a repo. */
const repoLike = (s: string) => /^[\w.-]+(\/[\w.-]+)?$/.test(s);

/**
 * Row-level fold: a sweep red-main risk is dropped when the writer already
 * has a decision (source main_health) or an incident with CI detail on the
 * same repo or product. The writer's row keeps its prompt and words; the
 * sweep's facts (repo, workflow, since, age, merges on top) fill whatever the
 * writer's CI detail left blank. Pure.
 */
export function foldMainHealth(risks: readonly BriefRisk[], decisions: readonly BriefDecision[]): BriefRisk[] {
  const sweepRows = risks.filter(isSweepCi);
  if (!sweepRows.length) return [...risks];
  const claims: { repo: string; product: string; risk: BriefRisk | null }[] = [
    ...decisions
      .filter((d) => d.source === "main_health")
      .map((d) => ({ repo: repoKey(d.origin.repo), product: productKey(d.origin.repo, d.origin.product), risk: null })),
    ...risks
      .filter((r) => !isSweepCi(r) && r.severity === "incident" && r.ci)
      .map((r) => ({ repo: repoKey(r.ci!.repo || r.origin.repo), product: productKey(r.origin.repo ?? r.ci!.repo, r.origin.product), risk: r })),
  ];
  const dropped = new Set<string>();
  const patched = new Map<string, NonNullable<BriefRisk["ci"]>>();
  for (const row of sweepRows) {
    const repo = repoKey(row.ci!.repo || row.origin.repo);
    const product = productKey(row.origin.repo, row.origin.product);
    const hit = claims.find((c) => (c.repo && c.repo === repo) || (c.product && c.product === product));
    if (!hit) continue;
    dropped.add(row.id);
    if (hit.risk?.ci) {
      const mine = patched.get(hit.risk.id) ?? hit.risk.ci;
      const sweep = row.ci!;
      patched.set(hit.risk.id, {
        ...mine,
        repo: repoLike(mine.repo) ? mine.repo : sweep.repo,
        workflow: mine.workflow ?? sweep.workflow,
        job: mine.job ?? sweep.job,
        since: mine.since ?? sweep.since,
        ageHours: mine.ageHours ?? sweep.ageHours,
        note: mine.note ?? sweep.note,
        ...(mine.mergesOnTop == null && sweep.mergesOnTop != null ? { mergesOnTop: sweep.mergesOnTop } : {}),
      });
    }
  }
  return risks.filter((r) => !dropped.has(r.id)).map((r) => (patched.has(r.id) ? { ...r, ci: patched.get(r.id)! } : r));
}

const MAX_HIGHLIGHTS = 5;

/**
 * Writer shipped rows onto the sweep rollups by product (or repo). The rollup
 * takes the writer's product name, `why`, highlights and median merge hours.
 * A named ship ("Desktop 0.11.3 is out") stays as its own row so the tile
 * keeps its headline and FIRST badge; a plain product row folds in, passing
 * its `first` to the rollup. Rows with no rollup are appended. Pure.
 */
export function mergeShipped(rollups: readonly BriefShipped[], writer: readonly BriefShipped[]): BriefShipped[] {
  const out = rollups.map((r) => ({ ...r }));
  const extra: BriefShipped[] = [];
  for (const w of writer) {
    const product = lower(w.origin.product);
    const repo = repoKey(w.origin.repo);
    const hit = out.find((r) => (product && productKey(r.origin.repo, r.origin.product) === product) || (repo && repoKey(r.origin.repo) === repo));
    if (!hit) {
      extra.push(w);
      continue;
    }
    if (w.origin.product) hit.origin = { ...hit.origin, product: w.origin.product };
    if (w.why && !hit.why) hit.why = w.why;
    if (w.highlights?.length) {
      const seen = new Set<string>();
      hit.highlights = [...(hit.highlights ?? []), ...w.highlights].filter((h) => !seen.has(lower(h)) && seen.add(lower(h))).slice(0, MAX_HIGHLIGHTS);
    }
    if (w.mergeHoursMedian != null && hit.mergeHoursMedian == null) hit.mergeHoursMedian = w.mergeHoursMedian;
    if (isNamedShip(w)) extra.push(w);
    else if (w.first) hit.first = true;
  }
  return [...out, ...extra];
}

/**
 * The writer's people over the DM team: matched by uid or first name, the
 * writer's status, tone, load, owes and thanks win while the DM count and
 * agent flag stay. Writer people come first; DM senders the writer did not
 * name follow. Pure.
 */
export function mergeTeam(team: readonly BriefTeammate[], people: readonly BriefTeammate[]): BriefTeammate[] {
  const rest = [...team];
  const out: BriefTeammate[] = [];
  for (const p of people) {
    const i = rest.findIndex((t) => t.id === p.id || lower(t.name) === lower(p.name));
    const hit = i >= 0 ? rest.splice(i, 1)[0]! : null;
    out.push(hit ? { ...hit, ...p, id: hit.id, isAgent: hit.isAgent || p.isAgent } : p);
  }
  return [...out, ...rest];
}

/**
 * The writer's meetings over the sweep's: matched by title or start, the
 * writer's decided / to-do lines, attendance, length and company win. A
 * writer meeting the sweep did not list is added when it has a start the
 * window gate can read. Pure.
 */
export function mergeMeetings(existing: readonly BriefMeeting[], writer: readonly BriefMeeting[]): BriefMeeting[] {
  const out = existing.map((m) => ({ ...m }));
  for (const w of writer) {
    const start = Date.parse(w.startTime);
    const hit = out.find((m) => lower(m.title) === lower(w.title) || (Number.isFinite(start) && Date.parse(m.startTime) === start));
    if (!hit) {
      if (Number.isFinite(start)) out.push({ ...w });
      continue;
    }
    if (w.decided?.length) hit.decided = w.decided;
    if (w.todo?.length) hit.todo = w.todo;
    if (w.attended !== undefined) hit.attended = w.attended;
    if (w.durationMin !== undefined) hit.durationMin = w.durationMin;
    if (w.with) hit.with = w.with;
    if (!hit.decisions && w.decisions) hit.decisions = w.decisions;
    if (!hit.actions && w.actions) hit.actions = w.actions;
  }
  return out;
}

/**
 * The writer's releases over the sweep's, by product or repo: held items,
 * the light and the prompt are the writer's; counts and pending days too
 * when it wrote them. Products the sweep did not list are appended. Pure.
 */
export function mergeReleases(existing: readonly BriefRelease[], writer: readonly BriefRelease[]): BriefRelease[] {
  const out = existing.map((r) => ({ ...r }));
  for (const w of writer) {
    const product = lower(w.product);
    const repo = repoKey(w.origin.repo);
    const at = out.findIndex((r) => lower(r.product) === product || (repo && repoKey(r.origin.repo) === repo));
    if (at < 0) {
      out.push({ ...w });
      continue;
    }
    const r = out[at]!;
    out[at] = {
      ...r,
      product: w.product,
      origin: { ...r.origin, product: w.product },
      version: w.version ?? r.version,
      releasedAt: w.releasedAt ?? r.releasedAt,
      pending: w.pending.length ? w.pending : r.pending,
      pendingCount: w.pending.length || w.pendingCount ? w.pendingCount : r.pendingCount,
      held: w.held,
      light: w.light,
      ...(w.prompt ?? r.prompt ? { prompt: w.prompt ?? r.prompt } : {}),
    };
  }
  return out;
}

/** A run's housekeeping.json, or null when it is absent or unreadable (logged). */
export async function readRunHousekeeping(
  source: BriefSweepSource,
  runId: string,
  log: (message: string, err?: unknown) => void = (m, e) => console.warn(`[daily-brief] ${m}`, e ?? ""),
): Promise<BriefHousekeeping | null> {
  try {
    const text = await source.readHqFile(briefRunPath(runId, "housekeeping.json"));
    if (text == null) return null;
    const parsed = parseHousekeeping(text);
    if (!parsed) log("housekeeping.json is not valid JSON");
    return parsed;
  } catch (err) {
    log("housekeeping.json failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Lays the sweep under the adapter's data: the adapter wins for the calendar
 * and for any list it filled; the sweep fills what the adapter left empty
 * plus what only it knows (PR totals, main CI, the brief's local date).
 */
async function mergeSweep(
  input: BriefInput,
  source: BriefSweepSource,
  opts: GatherOptions,
  now: Date,
  yesterday: Date,
  fail: (name: string, err: unknown) => void,
): Promise<void> {
  let text: string | null;
  try {
    text = await source.readHqFile(sweepPath(now, opts.runId));
  } catch (err) {
    fail("sweep", err);
    return;
  }
  if (text == null) {
    if (opts.runId) fail("brief-data.json", new SourceError("brief-data.json: not written"));
    return;
  }
  const sweep = parseSweep(text);
  if (!sweep) {
    fail("sweep", new SourceError("sweep: brief-data.json is not valid JSON"));
    return;
  }
  const s = sweepToInput(sweep, { day: localDay(yesterday), companyUid: opts.sweepCompanyUid ?? opts.companies[0]?.uid ?? null });
  if (!input.meetingsYesterday.length) input.meetingsYesterday = s.meetingsYesterday;
  if (!input.shipped.length) input.shipped = s.shipped;
  if (!input.team.length) input.team = s.team;
  if (!input.sessions.length) input.sessions = s.sessions;
  input.risks = [...input.risks, ...s.risks];
  input.merged = input.merged ?? s.merged;
  input.opened = input.opened ?? s.opened;
  if (s.today) input.today = s.today;
  input.prWindow = input.prWindow ?? s.prWindow;
  input.dmCount = Math.max(input.dmCount ?? 0, s.dmCount ?? 0);
  // Only the sweep knows these.
  if (s.mainHealth?.length) input.mainHealth = input.mainHealth ?? s.mainHealth;
  if (s.fleetIncident) input.fleetIncident = input.fleetIncident ?? s.fleetIncident;
  if (s.releases?.length) input.releases = input.releases ?? s.releases;
}

/**
 * Adds today's recorded meetings that already happened and are missing from
 * the calendar feed (it only lists what is ahead). A recorded meeting within
 * 30 minutes of a same-titled calendar event is the same call.
 */
export function mergePastMeetings(calendar: BriefCalendarEvent[], recorded: BriefCalendarEvent[], now: Date): BriefCalendarEvent[] {
  const extra = recorded.filter(
    (r) =>
      Date.parse(r.start) <= now.getTime() &&
      !calendar.some(
        (c) => c.title.toLowerCase() === r.title.toLowerCase() && Math.abs(Date.parse(c.start) - Date.parse(r.start)) < 30 * 60_000,
      ),
  );
  return [...calendar, ...extra].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

async function readMeetings(
  adapter: BriefAdapter,
  companies: readonly BriefCompanyRef[],
  yesterday: Date,
  fail: (name: string, err: unknown) => void,
): Promise<{
  meetings: BriefMeeting[];
  decisions: BriefDecision[];
  actionItems: BriefActionItem[];
  risks: BriefRisk[];
  todayRecorded: BriefCalendarEvent[];
}> {
  const api = adapter.meetings;
  const meetings: BriefMeeting[] = [];
  const todayRecorded: BriefCalendarEvent[] = [];
  const today = new Date(yesterday.getTime() + 86_400_000);
  const decisions: BriefDecision[] = [];
  const actionItems: BriefActionItem[] = [];
  const risks: BriefRisk[] = [];
  if (!api?.listRecorded || !api.getRecorded) {
    fail("meetings", new SourceError("meetings: unavailable on this host"));
    return { meetings, decisions, actionItems, risks, todayRecorded };
  }
  let reads = BODY_READS;
  const body = async (url: string | null, fallback: string | null): Promise<string | null> => {
    if (fallback) return fallback;
    if (!url || reads <= 0 || !api.readRecordedBody) return null;
    reads -= 1;
    try {
      return signalTitle(await unwrap("signal body", api.readRecordedBody(url))) || null;
    } catch (err) {
      fail("signal body", err);
      return null;
    }
  };

  for (const company of companies) {
    let rows;
    try {
      rows = parseRecordedMeetings(await unwrap(`meetings ${company.label}`, api.listRecorded(company.uid)));
    } catch (err) {
      fail(`meetings ${company.label}`, err);
      continue;
    }
    // The calendar feed only lists what is still ahead; recorded meetings fill in today's earlier calls.
    for (const m of rows.filter((r) => sameLocalDay(r.startTime, today))) {
      todayRecorded.push({ id: `rec:${m.meetingId}`, title: m.title, start: m.startTime, end: m.endTime ?? null, kind: "team" });
    }
    const mine = rows.filter((m) => sameLocalDay(m.startTime, yesterday)).slice(0, MEETINGS_PER_COMPANY);
    for (const m of mine) {
      let signals: ReturnType<typeof signalsByKind> = { decisions: [], actions: [], risks: [], questions: [] };
      if (m.hasSignals) {
        try {
          signals = signalsByKind(await unwrap(`meeting ${m.meetingId}`, api.getRecorded(m.meetingId, company.uid)));
        } catch (err) {
          fail(`meeting ${m.meetingId}`, err);
        }
      }
      meetings.push({
        id: m.meetingId,
        title: m.title,
        startTime: m.startTime,
        companyUid: company.uid,
        decisions: signals.decisions.length,
        actions: signals.actions.length,
        risks: signals.risks.length,
        questions: signals.questions.length,
        // Signal titles are often only in the body file; read the few the peek shows.
        decided: (await Promise.all(signals.decisions.slice(0, 3).map((d) => body(d.url, d.title)))).filter((t): t is string => !!t),
        todo: (await Promise.all(signals.actions.slice(0, 3).map((a) => body(a.url, a.title))))
          .filter((t): t is string => !!t)
          .map((text) => ({ text })),
      });
      const origin = { companyUid: company.uid, repo: m.title };
      for (const [i, q] of signals.questions.entries()) {
        const title = await body(q.url, q.title);
        if (!title) continue;
        decisions.push({
          id: `${m.meetingId}:q${i}`,
          title,
          summary: `Open question from ${m.title}`,
          action: "decide",
          actionLabel: "Decide",
          origin,
          detail: { why: title, unlocks: [], source: `Signal · question · ${m.title}` },
        });
      }
      for (const [i, a] of signals.actions.entries()) {
        const title = await body(a.url, a.title);
        if (title) actionItems.push({ id: `${m.meetingId}:a${i}`, title, origin });
      }
      for (const [i, r] of signals.risks.entries()) {
        const title = await body(r.url, r.title);
        if (!title) continue;
        risks.push({ id: `${m.meetingId}:r${i}`, title, summary: `Raised in ${m.title}`, severity: "watch", links: [], origin });
      }
    }
  }
  meetings.sort((a, b) => b.decisions + b.actions - (a.decisions + a.actions));
  return { meetings, decisions, actionItems, risks, todayRecorded };
}

async function readDms(
  adapter: BriefAdapter,
  now: Date,
  yesterday: Date,
  selfUid: string,
  fail: (name: string, err: unknown) => void,
): Promise<{ team: BriefTeammate[]; waiting: BriefWaiting[]; count: number }> {
  const team: BriefTeammate[] = [];
  const waiting: BriefWaiting[] = [];
  let page: Json;
  try {
    page = await unwrap("dm threads", adapter.notifications?.fetchDmThreads?.({ limit: 100 }));
  } catch (err) {
    fail("dm threads", err);
    return { team, waiting, count: 0 };
  }
  const threads = Array.isArray(page.threads) ? page.threads.map(rec) : [];
  let count = 0;
  for (const t of threads) {
    const uid = str(t.peerUid);
    const at = str(t.lastActivityAt);
    if (!uid || uid === selfUid || !at) continue;
    if (!sameLocalDay(at, yesterday) && !sameLocalDay(at, now)) continue;
    count += 1;
    const name = str(t.peerName) || str(t.peerDisplayName) || str(t.displayName);
    if (!name) continue;
    const last = rec(t.lastMessage);
    const fromMe = t.lastFromSelf === true || (selfUid !== "" && str(last.senderUid) === selfUid);
    if (fromMe) waiting.push({ id: uid, who: name.split(/\s+/)[0]!, what: "to reply to your DM" });
    if (team.length < 6) {
      team.push({
        id: uid,
        name: name.split(/\s+/)[0]!,
        doing: fromMe ? "You are waiting on a reply" : "Talked with you yesterday",
        tone: fromMe ? "warn" : "ok",
      });
    }
  }
  return { team, waiting, count };
}
