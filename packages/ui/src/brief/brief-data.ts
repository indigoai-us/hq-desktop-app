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
 * No adapter route reports shipped PRs or fleet health yet, so `shipped` and
 * incident risks stay empty unless a seed supplies them.
 */

import type { AdapterPromise, Json, WhoAmI } from "@hq/platform";
import { parseRecordedMeetings, signalBodyText } from "../meetings/recorded-meetings.js";
import { localSessionsFromNative } from "../telemetry/telemetry-local-sessions.js";
import { eventEnd, eventMeetingUrl, eventStart, type MeetingEvent } from "../meetings/meetings-model.js";
import { briefSeed } from "./brief-seed.js";
import { parseSweep, sweepToInput } from "./brief-sweep.js";
import { parseBriefItems, parseHousekeeping, type BriefHousekeeping } from "./brief-run-files.js";
import { briefRunPath } from "./brief-runs.js";
import type {
  BriefActionItem,
  BriefCalendarEvent,
  BriefDecision,
  BriefInput,
  BriefMeeting,
  BriefRisk,
  BriefSession,
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
  log?: (message: string, err?: unknown) => void;
}

export interface GatherResult {
  input: BriefInput;
  /** Sources that failed or were unavailable, by name. */
  failures: string[];
}

/** Recorded meetings read per company, and signal bodies read in total. */
export const MEETINGS_PER_COMPANY = 5;
export const BODY_READS = 10;
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
        return page.rows.map(
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
      now: now.toISOString(),
      userName,
      companies: companies.flatMap((c) => [c.uid, ...(c.slug ? [c.slug] : [])]),
      calendarToday: calendar,
      meetingsYesterday: meetings.meetings,
      decisions: meetings.decisions,
      actionItems: meetings.actionItems,
      risks: meetings.risks,
      shipped: [],
      merged: null,
      opened: null,
      waitingOn: dms.waiting,
      team: dms.team,
      sessions: sessions.filter((s) => localDay(new Date(s.startedAt)) === localDay(yesterday)),
      recentSessions: sessions.filter((s) => {
        const t = Date.parse(s.startedAt);
        return t > now.getTime() - 24 * 3600_000 && t <= now.getTime();
      }),
      lastBriefAt: opts.lastBriefAt ?? null,
      dmCount: dms.count,
  };
  const sweep = opts.sweep === undefined ? adapterSweepSource(adapter.files) : opts.sweep;
  if (sweep) await mergeSweep(input, sweep, opts, now, yesterday, fail);
  if (sweep && opts.runId) await mergeRunItems(input, sweep, opts, fail);
  return { input, failures };
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
  if (items.decisions.length) input.decisions = items.decisions;
  if (items.waiting.length) input.waitingOn = items.waiting;
  input.risks = [...items.incidents, ...input.risks];
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
 * plus what only it knows (PR totals, fleet, main CI).
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
  input.fleet = input.fleet ?? s.fleet;
  input.prWindow = input.prWindow ?? s.prWindow;
  input.dmCount = Math.max(input.dmCount ?? 0, s.dmCount ?? 0);
}

async function readMeetings(
  adapter: BriefAdapter,
  companies: readonly BriefCompanyRef[],
  yesterday: Date,
  fail: (name: string, err: unknown) => void,
): Promise<{ meetings: BriefMeeting[]; decisions: BriefDecision[]; actionItems: BriefActionItem[]; risks: BriefRisk[] }> {
  const api = adapter.meetings;
  const meetings: BriefMeeting[] = [];
  const decisions: BriefDecision[] = [];
  const actionItems: BriefActionItem[] = [];
  const risks: BriefRisk[] = [];
  if (!api?.listRecorded || !api.getRecorded) {
    fail("meetings", new SourceError("meetings: unavailable on this host"));
    return { meetings, decisions, actionItems, risks };
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
        decided: signals.decisions.map((d) => d.title).filter((t): t is string => !!t).slice(0, 3),
        todo: signals.actions.map((a) => a.title).filter((t): t is string => !!t).slice(0, 2),
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
  return { meetings, decisions, actionItems, risks };
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
