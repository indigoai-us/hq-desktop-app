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
  notifications?: { fetchDmThreads?(opts?: Json): AdapterPromise<Json> } | null;
  agents?: {
    listLocalSessions?(
      range: { from: string; to: string },
      page?: { offset?: number; limit?: number },
    ): AdapterPromise<Json>;
  } | null;
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

let seed: (() => BriefInput) | null = null;

/** Dev harness only: serve this day instead of reading the adapter. */
export function configureBriefSeed(next: (() => BriefInput) | null): void {
  seed = next;
}

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

/** Today's calendar events from the upcoming feed, classified for the strip. */
export function calendarToday(raw: readonly Json[], now: Date, selfEmail: string): BriefCalendarEvent[] {
  const domain = selfEmail.split("@")[1]?.toLowerCase() ?? "";
  const out: BriefCalendarEvent[] = [];
  for (const item of raw) {
    const e = rec(item);
    if (str(e.status) === "cancelled") continue;
    const start = str(rec(e.start).dateTime);
    if (!start || !sameLocalDay(start, now)) continue;
    const title = str(e.summary) || "Busy";
    const attendees = Array.isArray(e.attendees) ? e.attendees.map(rec) : [];
    const outside =
      domain !== "" &&
      attendees.some((a) => {
        const email = str(a.email).toLowerCase();
        return email.includes("@") && !email.endsWith(`@${domain}`) && !email.endsWith("calendar.google.com");
      });
    out.push({
      id: str(e.id) || `${start}-${title}`,
      title,
      start,
      end: str(rec(e.end).dateTime) || null,
      kind: LEARN.test(title) ? "learn" : outside ? "ext" : "team",
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
        const day = localDay(yesterday);
        const page = localSessionsFromNative(
          await unwrap("sessions", adapter.agents?.listLocalSessions?.({ from: day, to: day }, { limit: 200 })),
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

  return {
    input: {
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
      sessions,
      lastBriefAt: opts.lastBriefAt ?? null,
      dmCount: dms.count,
    },
    failures,
  };
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
