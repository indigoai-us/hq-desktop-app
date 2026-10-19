/**
 * Company Outpost jobs (US-004, US-006).
 *
 * The desktop submits a revision to POST /outpost/company/jobs and reads
 * health from GET /outpost/company/jobs/status. An admin revision is accepted
 * only when the response carries acceptedRevision. Anything else is waiting
 * for an admin and is not runnable. A client registered_by value is never
 * sent. Alerts go to every current owner and admin; the job record has no
 * notify field.
 */
import type { NavigationDestination } from "../shell/navigation-history.js";

/** Stable route Lane A links to. */
export const OUTPOST_JOBS_ROUTE = "outpost-jobs";

export const JOBS_COLLECTION_PATH = "/outpost/company/jobs";
export const JOBS_STATUS_PATH = "/outpost/company/jobs/status";

export const WATCHDOG_NAME = "watchdog-refresh";
export const WATCHDOG_PROMPT =
  "Check that this company Outpost is signed in and that its scheduled jobs are running. Write a short health note with the UTC time. Do not change anything.";
/** Twice a day at 8:00 and 20:00. Current CLI form from the Ridge ready kit. */
export const WATCHDOG_CRON = "cron(0 8,20 ? * * *)";
export const WATCHDOG_TIMEZONE = "America/New_York";

export const ALERT_AUDIENCE = "admins" as const;
export const ALERT_AUDIENCE_LABEL = "Every company owner and admin";

export type CompanyJobRole = "owner" | "admin" | "member" | "unknown";
export type JobRunMode = "prompt" | "skill";
export type SchedulePresetId = "hourly" | "daily" | "weekdays" | "weekly" | "twice-daily" | "custom";
export type JobHealth = "ok" | "missed" | "blocked" | "stale" | "unknown";
export type JobDisplay = JobHealth | "paused";
export type Acceptance = "accepted" | "pending";

export interface SchedulePreset {
  id: Exclude<SchedulePresetId, "custom">;
  cron: string;
  label: string;
}

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  { id: "hourly", cron: "cron(0 * * * ? *)", label: "Every hour" },
  { id: "daily", cron: "cron(0 8 * * ? *)", label: "Every day at 8:00" },
  { id: "weekdays", cron: "cron(0 9 ? * MON-FRI *)", label: "Every weekday at 9:00" },
  { id: "weekly", cron: "cron(0 9 ? * MON *)", label: "Every Monday at 9:00" },
  { id: "twice-daily", cron: WATCHDOG_CRON, label: "Every day at 8:00 and 20:00" },
];

export interface CompanyBoxOption {
  id: string;
  name: string;
  blocked?: boolean;
  stopped?: boolean;
  /** Blocked because the company cannot run Outposts yet. Set only when true. */
  unavailable?: boolean;
}

export interface JobDraft {
  name: string;
  mode: JobRunMode;
  prompt: string;
  skill: string;
  preset: SchedulePresetId;
  customCron: string;
  timezone: string;
  boxId: string;
  alertAudience: string;
}

export interface ParsedCompanyJob {
  jobId: string;
  name: string;
  outpostId: string;
  prompt: string;
  skill: string | null;
  cron: string;
  timezone: string;
  paused: boolean;
  deleted: boolean;
  accepted: boolean;
  revision: string | null;
  registeredBy: string;
  latestEditor: string;
}

export interface ParsedJobHealth {
  jobId: string;
  status: JobHealth;
  lastRunAt: string | null;
  nextRunAt: string | null;
  message: string;
  nextStep: string;
}

export interface ListedCompanyJob extends ParsedCompanyJob {
  health: JobHealth;
  display: JobDisplay;
  displayLabel: string;
  scheduleLabel: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  message: string;
  nextStep: string;
}

const WEEKDAY_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAY_CODE: Record<string, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

const MIN_INTERVAL_SECONDS = 5 * 60;

export function canManageCompanyJobs(role: CompanyJobRole): boolean {
  return role === "owner" || role === "admin";
}

export function outpostJobsDestination(
  companyUid: string,
  outpostId?: string | null,
): NavigationDestination {
  const params = new URLSearchParams();
  if (outpostId) params.set("outpostId", outpostId);
  if (companyUid) params.set("company", companyUid);
  const param = params.toString();
  return {
    kind: "extra",
    page: OUTPOST_JOBS_ROUTE,
    companyUid,
    ...(param ? { param } : {}),
  };
}

export function parseOutpostJobsParam(
  param: string | null | undefined,
): { outpostId: string | null; companyUid: string | null } {
  const raw = param?.trim() ?? "";
  if (!raw) return { outpostId: null, companyUid: null };
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw;
  try {
    const params = new URLSearchParams(query);
    const outpostId = params.get("outpostId")?.trim() || null;
    const companyUid = params.get("company")?.trim() || null;
    if (!params.has("outpostId") && !params.has("company") && !raw.includes("=")) {
      return { outpostId: raw, companyUid: null };
    }
    return { outpostId, companyUid };
  } catch {
    return { outpostId: null, companyUid: null };
  }
}

export function blankJobDraft(boxId = ""): JobDraft {
  return {
    name: "",
    mode: "prompt",
    prompt: "",
    skill: "",
    preset: "weekdays",
    customCron: SCHEDULE_PRESETS[2].cron,
    timezone: defaultTimezone(),
    boxId,
    alertAudience: ALERT_AUDIENCE,
  };
}

/** One-click Watchdog health check. Every field stays editable after this fill. */
export function watchdogDraft(boxId: string): JobDraft {
  return {
    name: WATCHDOG_NAME,
    mode: "prompt",
    prompt: WATCHDOG_PROMPT,
    skill: "",
    preset: "twice-daily",
    customCron: WATCHDOG_CRON,
    timezone: WATCHDOG_TIMEZONE,
    boxId,
    alertAudience: ALERT_AUDIENCE,
  };
}

export function defaultTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && validTimezone(zone) ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

export function validTimezone(zone: string): boolean {
  const name = zone.trim();
  if (!name) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: name }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function draftCron(draft: Pick<JobDraft, "preset" | "customCron">): string {
  if (draft.preset === "custom") return draft.customCron.trim();
  return SCHEDULE_PRESETS.find((preset) => preset.id === draft.preset)?.cron ?? "";
}

export function schedulePlainWords(expr: string): string {
  const parsed = parseSchedule(expr.trim());
  if (!parsed) return "";
  if (parsed.kind === "rate") {
    const unit = parsed.unit.startsWith("minute")
      ? "minute"
      : parsed.unit.startsWith("hour")
        ? "hour"
        : "day";
    if (parsed.every === 1 && unit === "day") return "Every day";
    if (parsed.every === 1) return `Every ${unit}`;
    return `Every ${parsed.every} ${unit}s`;
  }
  const { minutes, hours, days } = parsed;
  if (minutes.length === 1 && minutes[0] === 0 && hours.length === 24 && days === "all") return "Every hour";
  if (minutes.length !== 1 || hours.length === 0 || hours.length === 24) return "Custom schedule";
  const times = hours.map((hour) => clock(hour, minutes[0]));
  const time = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
  if (days === "all") return `Every day at ${time}`;
  if (sameDays(days, [1, 2, 3, 4, 5])) return `Every weekday at ${time}`;
  if (days.length === 1) return `Every ${WEEKDAY_NAME[days[0]]} at ${time}`;
  return `Every ${days.map((day) => WEEKDAY_NAME[day]).join(", ")} at ${time}`;
}

export function scheduleError(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return "Choose a schedule.";
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(trimmed) && !trimmed.startsWith("cron(") && !trimmed.startsWith("rate(")) {
    return "That schedule was not accepted. Use an EventBridge cron or rate expression.";
  }
  const parsed = parseSchedule(trimmed);
  if (!parsed) return "That schedule was not accepted. Use an EventBridge cron or rate expression.";
  if (parsed.kind === "rate") {
    const seconds = rateSeconds(parsed.every, parsed.unit);
    if (seconds < MIN_INTERVAL_SECONDS) return "Recurring jobs may not run more often than every 5 minutes.";
    return "";
  }
  if (minuteGapSeconds(parsed.minutes) < MIN_INTERVAL_SECONDS) {
    return "Recurring jobs may not run more often than every 5 minutes.";
  }
  return "";
}

export function validateJobDraft(
  draft: JobDraft,
  takenNames: readonly string[],
  editingName?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Enter a job name.";
  else if (name.length > 60 || !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(name)) {
    errors.name = "Use 1 to 60 letters, numbers, spaces, or dashes.";
  } else if (
    takenNames.some((existing) => existing.toLowerCase() === name.toLowerCase()) &&
    name.toLowerCase() !== (editingName ?? "").trim().toLowerCase()
  ) {
    errors.name = "That job name is already in use on this Outpost.";
  }
  if (draft.mode === "skill") {
    const skill = draft.skill.trim();
    if (!skill) errors.run = "Enter a skill reference.";
    else if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(skill)) errors.run = "Enter a skill reference such as weekly-review.";
  } else {
    const prompt = draft.prompt.trim();
    if (!prompt) errors.run = "Describe what this job runs.";
    else if (byteLength(prompt) > 16 * 1024) errors.run = "That prompt is too long.";
  }
  const cronError = scheduleError(draftCron(draft));
  if (cronError) errors.schedule = cronError;
  if (!validTimezone(draft.timezone)) errors.schedule = errors.schedule || "Enter a timezone such as America/New_York.";
  if (!draft.boxId.trim()) errors.box = "Choose an Outpost.";
  if (draft.alertAudience !== ALERT_AUDIENCE) {
    errors.alert = "Alerts go to every current company owner and admin.";
  }
  return errors;
}

/** Definition posted as the revision. registered_by is never included. */
export function revisionDefinition(draft: JobDraft): Record<string, unknown> {
  const prompt = draft.mode === "skill" ? draft.skill.trim() : draft.prompt.trim();
  const context: Record<string, unknown> = { name: draft.name.trim() };
  if (draft.mode === "skill") context.skill = draft.skill.trim();
  return {
    prompt,
    context,
    schedule: {
      kind: "recurring",
      cron: draftCron(draft),
      timezone: draft.timezone.trim(),
    },
  };
}

export function sanitizeJobBody(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "registered_by" || key === "registeredBy" || key === "actor" || key === "sessionFingerprint") continue;
    if (key === "definition" && value && typeof value === "object" && !Array.isArray(value)) {
      next.definition = sanitizeJobBody(value as Record<string, unknown>);
      continue;
    }
    if (key === "context" && value && typeof value === "object" && !Array.isArray(value)) {
      const context = sanitizeJobBody(value as Record<string, unknown>);
      delete context.notify;
      delete context.alert;
      next.context = context;
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function classifyAcceptance(body: unknown): Acceptance {
  const rec = asRecord(body);
  if (!rec) return "pending";
  if (rec.acceptance === "pending") return "pending";
  const job = asRecord(rec.job) ?? rec;
  return typeof job.acceptedRevision === "string" && job.acceptedRevision.length > 0 ? "accepted" : "pending";
}

export function isRunnableJob(job: { accepted: boolean; paused: boolean; deleted?: boolean }): boolean {
  return job.accepted && !job.paused && !job.deleted;
}

export function healthFromUnknown(value: unknown): JobHealth {
  if (value === "ok" || value === "missed" || value === "blocked" || value === "stale" || value === "unknown") return value;
  return "unknown";
}

export function displayStatus(paused: boolean, health: JobHealth): JobDisplay {
  if (health === "missed" || health === "blocked" || health === "stale") return health;
  if (paused) return "paused";
  return health;
}

export function displayLabel(status: JobDisplay): string {
  if (status === "ok") return "Ran on time";
  if (status === "missed") return "Missed";
  if (status === "blocked") return "Blocked";
  if (status === "stale") return "Out of date";
  if (status === "paused") return "Paused";
  return "Unknown";
}

export function parseCompanyJob(row: unknown): ParsedCompanyJob | null {
  const rec = asRecord(row);
  if (!rec || typeof rec.jobId !== "string" || !rec.jobId) return null;
  const context = asRecord(rec.context);
  const schedule = asRecord(rec.schedule);
  const target = asRecord(rec.target);
  const prompt = typeof rec.prompt === "string" ? rec.prompt : "";
  const skill = context && typeof context.skill === "string" ? context.skill : null;
  const name = context && typeof context.name === "string" && context.name.trim()
    ? context.name.trim()
    : clipLabel(prompt) || rec.jobId;
  const revision = typeof rec.acceptedRevision === "string" && rec.acceptedRevision ? rec.acceptedRevision : null;
  return {
    jobId: rec.jobId,
    name,
    outpostId: (target && typeof target.outpostId === "string" && target.outpostId) || (typeof rec.agentUid === "string" ? rec.agentUid : ""),
    prompt,
    skill,
    cron: schedule && typeof schedule.cron === "string" ? schedule.cron : "",
    timezone: schedule && typeof schedule.timezone === "string" ? schedule.timezone : "",
    paused: rec.status === "paused",
    deleted: rec.deleted === true,
    accepted: revision !== null,
    revision,
    registeredBy: typeof rec.registeredBy === "string" ? rec.registeredBy : "",
    latestEditor: typeof rec.latestEditor === "string" ? rec.latestEditor : "",
  };
}

export function parseJobHealth(row: unknown): ParsedJobHealth | null {
  const rec = asRecord(row);
  if (!rec || typeof rec.jobId !== "string" || !rec.jobId) return null;
  return {
    jobId: rec.jobId,
    status: healthFromUnknown(rec.status),
    lastRunAt: typeof rec.lastRunAt === "string" ? rec.lastRunAt : null,
    nextRunAt: typeof rec.nextRunAt === "string" ? rec.nextRunAt : null,
    message: typeof rec.message === "string" ? rec.message : "",
    nextStep: typeof rec.nextStep === "string" ? rec.nextStep : "",
  };
}

export function mergeJobHealth(jobs: readonly ParsedCompanyJob[], health: readonly ParsedJobHealth[]): ListedCompanyJob[] {
  const byId = new Map(health.map((row) => [row.jobId, row]));
  return jobs.filter((job) => !job.deleted).map((job) => {
    const row = byId.get(job.jobId);
    const status = row?.status ?? "unknown";
    const display = displayStatus(job.paused, status);
    return {
      ...job,
      health: status,
      display,
      displayLabel: displayLabel(display),
      scheduleLabel: schedulePlainWords(job.cron) || "Custom schedule",
      lastRunAt: row?.lastRunAt ?? null,
      nextRunAt: job.paused ? null : row?.nextRunAt ?? null,
      message: row?.message ?? "",
      nextStep: row?.nextStep ?? "",
    };
  });
}

export function jobsFromHealthOnly(health: readonly ParsedJobHealth[]): ListedCompanyJob[] {
  return health.map((row) => {
    const display = displayStatus(false, row.status);
    return {
      jobId: row.jobId,
      name: row.jobId,
      outpostId: "",
      prompt: "",
      skill: null,
      cron: "",
      timezone: "",
      paused: false,
      deleted: false,
      accepted: true,
      revision: null,
      registeredBy: "",
      latestEditor: "",
      health: row.status,
      display,
      displayLabel: displayLabel(display),
      scheduleLabel: "Custom schedule",
      lastRunAt: row.lastRunAt,
      nextRunAt: row.nextRunAt,
      message: row.message,
      nextStep: row.nextStep,
    };
  });
}

export function logSummary(job: ListedCompanyJob): string {
  if (job.message) return job.message;
  if (job.display === "missed") return "The job missed its expected completion time.";
  if (job.display === "stale") return "The job completed but its data did not advance.";
  if (job.display === "blocked") return "The last run was blocked.";
  if (job.display === "paused") return "The job is paused.";
  if (job.display === "unknown") return "Job status is unknown.";
  return "The last scheduled run succeeded.";
}

/** List rows from GET /outpost/status, or the single legacy `{ outpost }` row. */
export function parseCompanyBoxes(body: unknown): CompanyBoxOption[] {
  const rec = asRecord(body);
  if (!rec) return [];
  const rows = Array.isArray(rec.outposts) ? rec.outposts : rec.outpost ? [rec.outpost] : [];
  const boxes: CompanyBoxOption[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item || typeof item.outpostId !== "string" || !item.outpostId) continue;
    const lifecycle = typeof item.lifecycle === "string" ? item.lifecycle : "";
    if (lifecycle === "destroyed") continue;
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "main";
    const box: CompanyBoxOption = {
      id: item.outpostId,
      name,
      blocked: lifecycle === "blocked",
      stopped: lifecycle === "stopped",
    };
    if (lifecycle === "blocked" && typeof item.blockedReason === "string" && isNotAvailableCode(item.blockedReason)) {
      box.unavailable = true;
    }
    boxes.push(box);
  }
  return boxes;
}

/**
 * Codes that mean the company cannot run Outposts yet. The screen shows one
 * neutral line and a Contact us action, and says nothing about why.
 */
const NOT_AVAILABLE_CODES = new Set([
  "billing_required",
  "payment_not_set_up",
  "payment_required",
  "payment_method_required",
]);

export const NOT_AVAILABLE_COPY = "Outposts are not available for this company yet.";
export const CONTACT_US_LABEL = "Contact us";
export const CONTACT_SENT_COPY = "HQ has been notified and will follow up by email.";
export const CONTACT_FAILED_COPY = "Something went wrong. Try again.";

export function isNotAvailableCode(code: string | null | undefined): boolean {
  return typeof code === "string" && NOT_AVAILABLE_CODES.has(code);
}

export function blockedBoxNote(box: CompanyBoxOption, manage: boolean): string | null {
  if (box.unavailable) return null;
  if (box.stopped) return "This Outpost is stopped. Scheduled jobs are paused until it is started.";
  if (box.blocked) {
    return manage
      ? "This Outpost needs attention. Scheduled jobs are paused. HQ has been notified and will follow up by email."
      : "This Outpost needs attention. Scheduled jobs are paused. An owner or admin has been notified.";
  }
  return null;
}

/** Server refusal copy from desktop-api-contract.md (shared keys and section 5). */
export function jobFailureCopy(code: string): string {
  if (isNotAvailableCode(code)) return NOT_AVAILABLE_COPY;
  if (code === "admin_required" || code === "forbidden") return "Only company owners and admins can do this.";
  if (code === "box_not_signed_in" || code === "not_signed_in" || code === "provider_not_signed_in") {
    return "Sign this Outpost in to Claude before adding or running jobs.";
  }
  if (
    code === "revision_required" ||
    code === "job_changed" ||
    code === "revision_not_accepted" ||
    code === "revision_not_runnable"
  ) {
    return "Someone else changed this job. Reload it and try again.";
  }
  if (code === "confirmed_host_required" || code === "job_target_changed") return "This Outpost is not ready for jobs yet.";
  if (code === "job_not_found") return "This job was removed.";
  if (code === "outpost_not_found") return "This Outpost was removed.";
  if (code === "invalid_definition") return "Check the prompt and schedule, then try again.";
  if (code === "schedule_in_past") return "Pick a time in the future.";
  if (code === "unsupported_schedule") return "That schedule is not supported. Pick a longer interval.";
  if (code === "feature_disabled") return "Company Outposts are paused right now. Try again later.";
  if (code === "invalid_outpost" || code === "invalid_input" || code === "invalid_body" || code === "invalid_target") {
    return "Something went wrong. Try again.";
  }
  if (code === "company_jobs_unavailable" || code === "company_job_freshness_unavailable" || code === "unavailable") {
    return "Could not load. Retry";
  }
  return "Could not save the job. Try again.";
}

function clock(hour: number, minute: number): string {
  return `${hour}:${minute.toString().padStart(2, "0")}`;
}

function sameDays(days: number[], expected: number[]): boolean {
  return days.length === expected.length && days.every((day, index) => day === expected[index]);
}

type ParsedSchedule =
  | { kind: "rate"; every: number; unit: string }
  | { kind: "cron"; minutes: number[]; hours: number[]; days: number[] | "all" };

function parseSchedule(expr: string): ParsedSchedule | null {
  const rate = expr.match(/^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i);
  if (rate) {
    const every = Number(rate[1]);
    if (!Number.isInteger(every) || every < 1) return null;
    return { kind: "rate", every, unit: rate[2].toLowerCase() };
  }
  const cron = expr.match(/^cron\(\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*\)$/i);
  if (!cron) return null;
  const [, minuteField, hourField, dom, month, dow, year] = cron;
  if ((dom !== "*" && dom !== "?") || month !== "*" || year !== "*") return null;
  const minutes = parseNumberField(minuteField, 0, 59);
  const hours = parseNumberField(hourField, 0, 23);
  const days = parseDow(dow);
  if (!minutes || !hours || !days) return null;
  return { kind: "cron", minutes: [...minutes].sort((a, b) => a - b), hours: [...hours].sort((a, b) => a - b), days };
}

function parseNumberField(field: string, min: number, max: number): Set<number> | null {
  if (field === "*" || field === "?") {
    const all = new Set<number>();
    for (let value = min; value <= max; value += 1) all.add(value);
    return all;
  }
  const step = field.match(/^\*\/(\d+)$/);
  if (step) {
    const every = Number(step[1]);
    if (!Number.isInteger(every) || every < 1) return null;
    const values = new Set<number>();
    for (let value = min; value <= max; value += every) values.add(value);
    return values.size > 0 ? values : null;
  }
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < min || value > max) return null;
    values.add(value);
  }
  return values.size > 0 ? values : null;
}

function parseDow(field: string): number[] | "all" | null {
  if (field === "*" || field === "?") return "all";
  const days = new Set<number>();
  for (const part of field.toUpperCase().split(",")) {
    const range = /^([A-Z]{3})-([A-Z]{3})$/.exec(part);
    if (range) {
      const start = WEEKDAY_CODE[range[1]];
      const end = WEEKDAY_CODE[range[2]];
      if (start === undefined || end === undefined || start > end) return null;
      for (let day = start; day <= end; day += 1) days.add(day);
      continue;
    }
    const day = WEEKDAY_CODE[part];
    if (day === undefined) return null;
    days.add(day);
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

function minuteGapSeconds(minutes: number[]): number {
  if (minutes.length <= 1) return 3600;
  let gap = 60;
  const ordered = [...minutes].sort((a, b) => a - b);
  for (let index = 1; index < ordered.length; index += 1) gap = Math.min(gap, ordered[index] - ordered[index - 1]);
  gap = Math.min(gap, ordered[0] + 60 - ordered[ordered.length - 1]);
  return gap * 60;
}

function rateSeconds(every: number, unit: string): number {
  if (unit.startsWith("minute")) return every * 60;
  if (unit.startsWith("hour")) return every * 3600;
  return every * 86400;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function clipLabel(value: string): string {
  const limit = 60;
  const trimmed = value.trim();
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
