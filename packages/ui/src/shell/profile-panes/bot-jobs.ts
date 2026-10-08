/**
 * Jobs tab of the bot profile pane: the bot's scheduled jobs from
 * `GET /v1/agents/{uid}/jobs`, each with a short derived name, its schedule
 * in plain words, next and last run, and whether it is on. Pure data.
 */

import { formatJobCadence, formatJobOutcome } from "../../chat/agent-detail-model.js";

export const JOB_FILTERS = ["all", "recurring", "one-off", "failed"] as const;
export type JobFilter = (typeof JOB_FILTERS)[number];

export const JOB_FILTER_LABEL: Record<JobFilter, string> = {
  all: "All",
  recurring: "Recurring",
  "one-off": "One-off",
  failed: "Failed",
};

export interface BotJob {
  id: string;
  /** Short name derived from the prompt. */
  name: string;
  prompt: string;
  kind: "recurring" | "one-off";
  /** "Weekdays at 9:00 AM", "Every 2 hours", "Once on Oct 9, 2026 at …". */
  schedule: string;
  /** Raw schedule expression, for the detail view. */
  expression: string;
  timezone: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: string | null;
  lastOutcomeKind: "succeeded" | "skipped" | "failed" | "unknown";
}

const NAME_MAX = 48;

const LEAD_IN = /^(?:please|pls|kindly|can you|could you|would you|you should|i want you to|i'd like you to|go ahead and|make sure to|remember to)\s+/i;

function humanizeCommand(cmd: string): string {
  const bare = cmd.replace(/^\//, "").split(":").pop() ?? "";
  const words = bare.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/**
 * A short name for a job from its prompt: the first meaningful line, without
 * markdown marks or a polite lead-in, cut to its first sentence and to 48
 * characters on a word boundary. A slash command names the job after the
 * command ("/indigo:daily-brief" → "Daily brief").
 */
export function deriveJobName(prompt: string): string {
  const lines = prompt.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  let line = lines[0] ?? "";
  line = line.replace(/^(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)/, "").replace(/\*\*|__|`/g, "").trim();
  const command = line.match(/^\/[\w:-]+/);
  if (command) {
    const name = humanizeCommand(command[0]);
    if (name) return name;
  }
  line = line.replace(/^(?:hey|hi)\b[^,]*,\s*/i, "");
  for (let i = 0; i < 3 && LEAD_IN.test(line); i += 1) line = line.replace(LEAD_IN, "");
  const sentence = line.match(/^(.+?)(?:[.!?](?:\s|$)|:\s)/);
  if (sentence?.[1]) line = sentence[1];
  line = line.replace(/[\s.,;:!?]+$/, "").trim();
  if (line.length > NAME_MAX) {
    const cut = line.slice(0, NAME_MAX + 1);
    const space = cut.lastIndexOf(" ");
    // A cut name never ends on a connector word ("…across all of…").
    const head = (space > 20 ? cut.slice(0, space) : cut.slice(0, NAME_MAX))
      .replace(/(?:\s+(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|with))+$/i, "")
      .replace(/[\s,;:-]+$/, "");
    line = `${head}…`;
  }
  if (!line) return "Untitled job";
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const DAY_NAMES: Record<string, string> = {
  SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday",
  "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday",
};

function clock(hour: number, minute: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minute).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

function zoneAbbr(tz: string | null, at: Date): string {
  if (!tz) return "";
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName");
    return part?.value ? ` ${part.value}` : ` ${tz}`;
  } catch {
    return ` ${tz}`;
  }
}

/**
 * Cron in plain words for the shapes jobs use: every N minutes, hourly at
 * :MM, daily, weekdays, named days. Anything else falls back to the shared
 * cadence wording ("Cron … ").
 */
export function scheduleInWords(
  expression: string,
  schedule: { kind?: string; cron?: string; at?: string; timezone?: string } | null,
  now: Date = new Date(),
): string {
  const tz = schedule?.timezone?.trim() || null;
  const cronBody = expression.match(/^cron\(\s*([^)]+)\)\s*$/i)?.[1]?.trim() || (schedule?.kind === "recurring" ? (schedule.cron ?? "").trim() : "");
  if (cronBody) {
    const [min = "", hour = "", dom = "*", , dow = "*"] = cronBody.split(/\s+/);
    const anyDom = dom === "*" || dom === "?";
    const anyDow = dow === "*" || dow === "?";
    const step = min.match(/^(?:\*|0)\/(\d+)$/);
    if (step && hour === "*" && anyDom && anyDow) return `Every ${step[1]} minutes`;
    if (/^\d+$/.test(min) && hour === "*" && anyDom && anyDow) return Number(min) === 0 ? "Every hour" : `Every hour at :${min.padStart(2, "0")}`;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && anyDom) {
      const at = `${clock(Number(hour), Number(min))}${zoneAbbr(tz, now)}`;
      if (anyDow) return `Every day at ${at}`;
      const d = dow.toUpperCase();
      if (d === "MON-FRI" || d === "1-5") return `Weekdays at ${at}`;
      if (d === "SAT,SUN" || d === "SUN,SAT" || d === "0,6" || d === "6,0") return `Weekends at ${at}`;
      const days = d.split(",").map((x) => DAY_NAMES[x]);
      if (days.length > 0 && days.every(Boolean)) {
        return days.length === 1 ? `Every ${days[0]} at ${at}` : `${days.map((x) => x!.slice(0, 3)).join(", ")} at ${at}`;
      }
    }
  }
  return formatJobCadence(expression, schedule, now);
}

/** "in 12 min", "in 3 h", "tomorrow 9:00 AM", "Oct 9, 9:00 AM"; "" when unknown. */
export function nextRunLabel(iso: string | null, now: Date = new Date()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const diff = t - now.getTime();
  if (diff < 60_000) return "due now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min} min`;
  if (min < 6 * 60) return `in ${Math.round(min / 60)} h`;
  const d = new Date(t);
  const time = clock(d.getHours(), d.getMinutes());
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** "4 min ago", "3 h ago", "2 d ago"; "" when unknown. */
export function lastRunLabel(iso: string | null, now: Date = new Date()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Rows of the operator jobs list, newest shape first, older shapes tolerated. */
export function botJobsFromPayload(payload: unknown, now: Date = new Date()): BotJob[] {
  const rec = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(payload) ? payload : Array.isArray(rec.jobs) ? rec.jobs : [];
  const out: BotJob[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = s(item.jobId) || s(item.id);
    if (!id) continue;
    const schedule = item.schedule && typeof item.schedule === "object" ? (item.schedule as { kind?: string; cron?: string; at?: string; timezone?: string }) : null;
    const expression = s(item.rate) || (typeof item.schedule === "string" ? s(item.schedule) : "") || s(schedule?.cron) || (schedule?.at ? `at(${schedule.at})` : "");
    const once = schedule?.kind === "once" || /^at\(/i.test(expression);
    const state = s(item.scheduleState).toUpperCase();
    const status = s(item.status).toLowerCase();
    const enabled = state ? state === "ENABLED" : item.active === false ? false : status !== "paused";
    const outcome = formatJobOutcome(s(item.lastRunOutcome) || s(item.lastStatus));
    const prompt = s(item.prompt);
    out.push({
      id,
      name: deriveJobName(prompt),
      prompt,
      kind: once ? "one-off" : "recurring",
      schedule: scheduleInWords(expression, schedule ?? (expression && !once ? { kind: "recurring", cron: expression } : null), now),
      expression,
      timezone: s(schedule?.timezone) || null,
      enabled,
      nextRunAt: s(item.nextRunAt) || null,
      lastRunAt: s(item.lastRunAt) || null,
      lastOutcome: outcome.label,
      lastOutcomeKind: outcome.kind,
    });
  }
  return out;
}

/** Failing jobs first, then the soonest next run; jobs with no next run last. */
export function sortJobs(jobs: readonly BotJob[]): BotJob[] {
  const next = (j: BotJob) => {
    const t = j.enabled && j.nextRunAt ? Date.parse(j.nextRunAt) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...jobs].sort((a, b) => {
    const fa = a.lastOutcomeKind === "failed" ? 0 : 1;
    const fb = b.lastOutcomeKind === "failed" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const na = next(a);
    const nb = next(b);
    if (na !== nb) return na < nb ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function filterJobs(jobs: readonly BotJob[], filter: JobFilter): BotJob[] {
  if (filter === "recurring") return jobs.filter((j) => j.kind === "recurring");
  if (filter === "one-off") return jobs.filter((j) => j.kind === "one-off");
  if (filter === "failed") return jobs.filter((j) => j.lastOutcomeKind === "failed");
  return [...jobs];
}
