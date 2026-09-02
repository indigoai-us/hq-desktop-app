/**
 * Pure view-model for the agent-detail side pane.
 *
 * Normalizes hq-pro agent status, scheduled-job list rows, company telemetry,
 * and owner rows into the labels the pane renders. No DOM, no adapter.
 */

export type AgentWorkStatus = "WORKING" | "IDLE" | "PROVISIONING";

export interface AgentDetailHeader {
  uid: string;
  displayName: string;
  description: string;
  status: AgentWorkStatus;
  ownerLabel: string | null;
  companies: string[];
  avatarUrl: string | null;
  modelLabel: string | null;
  provider: string | null;
  runtimeStatus: string | null;
  canManage: boolean;
}

export interface AgentJobRow {
  jobId: string;
  title: string;
  prompt: string;
  cadence: string;
  runningFor: string | null;
  lastRan: string | null;
  lastOutcome: string | null;
  lastOutcomeKind: "succeeded" | "skipped" | "failed" | "unknown";
  active: boolean;
  canPause: boolean;
}

export interface AgentUsageModelBar {
  model: string;
  tokens: number;
  pct: number;
}

export interface AgentUsageView {
  tokens: number;
  sessions: number | null;
  stories: number | null;
  deploys: number | null;
  outcomesPerMillion: number | null;
  dailyTokens: number[];
  tokensByModel: AgentUsageModelBar[];
  topSkills: Array<{ skill: string; count: number }>;
  projects: string[];
}

export type LoadState<T> =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; value: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function isoDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function defaultTelemetryRange(
  days = 30,
  now: Date = new Date(),
): { from: string; to: string } {
  const to = now;
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: isoDay(from), to: isoDay(to) };
}

export function jobTitleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\r\n/g, "\n").split("\n").find((l) => l.trim());
  return (line ?? "").trim() || "Untitled job";
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Decode the millisecond timestamp encoded in a `job_<ulid>` id. */
export function createdAtFromJobId(jobId: string): string | null {
  const raw = jobId.trim().replace(/^job_/i, "");
  if (raw.length < 10) return null;
  let time = 0;
  for (let i = 0; i < 10; i++) {
    const idx = CROCKFORD.indexOf(raw[i]!.toUpperCase());
    if (idx < 0) return null;
    time = time * 32 + idx;
  }
  if (!Number.isFinite(time) || time <= 0) return null;
  return new Date(time).toISOString();
}

export function formatRunningFor(
  createdAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!createdAt) return null;
  const then = new Date(createdAt).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.max(0, Math.floor((now.getTime() - then) / 86_400_000));
  if (days === 0) return "Running for less than a day";
  if (days === 1) return "Running for 1 day";
  return `Running for ${days} days`;
}

export function formatRelativeAgo(
  iso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function formatJobOutcome(raw: string | null | undefined): {
  label: string | null;
  kind: AgentJobRow["lastOutcomeKind"];
} {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return { label: null, kind: "unknown" };
  if (value === "succeeded" || value === "delivered") {
    return { label: "succeeded", kind: "succeeded" };
  }
  if (value === "skipped-precondition") {
    return { label: "skipped (precondition)", kind: "skipped" };
  }
  if (value === "skipped-disabled" || value === "skipped-overlap") {
    return { label: "skipped", kind: "skipped" };
  }
  if (value === "failed" || value === "missed-expired") {
    return { label: "failed", kind: "failed" };
  }
  return { label: value, kind: "unknown" };
}

function timezoneAbbr(tz: string, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "short",
    }).formatToParts(at);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? tz;
  } catch {
    return tz;
  }
}

function formatClock(hour: number, minute: number): string {
  const h24 = ((hour % 24) + 24) % 24;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  if (minute === 0) return `${h12} ${suffix}`;
  return `${h12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

const RATE_RE = /^rate\(\s*(\d+)\s+(minute|minutes|hour|hours|day|days)\s*\)$/i;
const AT_RE = /^at\(\s*([^)]+)\)\s*$/i;
const CRON_RE = /^cron\(\s*([^)]+)\)\s*$/i;

export function formatJobCadence(
  rate: string | null | undefined,
  schedule?: {
    kind?: string;
    at?: string;
    cron?: string;
    timezone?: string;
  } | null,
  now: Date = new Date(),
): string {
  const tz = str(schedule?.timezone);
  const expression = str(rate) || str(schedule?.cron) || "";
  const rateMatch = expression.match(RATE_RE);
  if (rateMatch) {
    const n = Number(rateMatch[1]);
    const unit = rateMatch[2].toLowerCase();
    if (n === 1 && unit.startsWith("hour")) return "Every hour";
    if (n === 1 && unit.startsWith("day")) return "Every day";
    if (n === 1 && unit.startsWith("minute")) return "Every minute";
    return `Every ${n} ${unit}`;
  }
  const atMatch = expression.match(AT_RE);
  const atIso = atMatch?.[1]?.trim() || (schedule?.kind === "once" ? str(schedule.at) : "");
  if (atIso) {
    const d = new Date(atIso);
    if (!Number.isNaN(d.getTime())) {
      const label = new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        ...(tz ? { timeZone: tz } : {}),
      }).format(d);
      return `Once on ${label}`;
    }
  }
  const cronMatch = expression.match(CRON_RE);
  const cronBody = cronMatch?.[1]?.trim() || (schedule?.kind === "recurring" ? str(schedule.cron) : "");
  if (cronBody) {
    const parts = cronBody.split(/\s+/);
    if (parts.length >= 2) {
      const minute = Number(parts[0]);
      const hour = Number(parts[1]);
      const dom = parts[2] ?? "*";
      const dow = parts[4] ?? "?";
      if (
        Number.isFinite(hour) &&
        Number.isFinite(minute) &&
        (dom === "*" || dom === "?") &&
        (dow === "*" || dow === "?")
      ) {
        const clock = formatClock(hour, minute);
        const zone = tz ? ` ${timezoneAbbr(tz, now)}` : "";
        return `Every day at ${clock}${zone}`.trim();
      }
    }
    return tz ? `Cron ${cronBody} (${tz})` : `Cron ${cronBody}`;
  }
  return expression || "Scheduled";
}

export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function tokenTotal(row: Record<string, unknown>): number {
  const keys = [
    "input",
    "output",
    "cacheCreation",
    "cacheRead",
    "inputTokens",
    "outputTokens",
    "cacheCreationTokens",
    "cacheReadTokens",
    "tokens",
    "total",
  ];
  let sum = 0;
  let any = false;
  for (const key of keys) {
    const n = finiteNumber(row[key]);
    if (n != null) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : 0;
}

export function deriveAgentWorkStatus(input: {
  setupPhase?: string | null;
  runtimeStatus?: string | null;
  taskHealth?: string | null;
}): AgentWorkStatus {
  const phase = (input.setupPhase ?? "").trim().toLowerCase();
  const runtime = (input.runtimeStatus ?? "").trim().toLowerCase();
  const task = (input.taskHealth ?? "").trim().toLowerCase();
  if (
    phase === "provisioning" ||
    phase === "failed" ||
    runtime === "pending" ||
    runtime === "launching"
  ) {
    return "PROVISIONING";
  }
  if (runtime === "running" && (task === "ok" || task === "degraded")) {
    return "WORKING";
  }
  return "IDLE";
}

export function unavailableMessage(
  result: { ok: false; reason: string; code?: string; message?: string },
  surface: "jobs" | "usage" | "status",
): string {
  const code = (result.code ?? "").toLowerCase();
  const message = (result.message ?? "").toLowerCase();
  const forbidden =
    code.includes("403") ||
    code.includes("forbidden") ||
    message.includes("forbidden") ||
    message.includes("owner or admin");
  if (forbidden) {
    if (surface === "jobs") {
      return "Scheduled jobs require owner or admin access.";
    }
    if (surface === "usage") {
      return "30-day usage requires owner or admin access.";
    }
    return "Agent details require owner or admin access.";
  }
  if (result.reason === "unavailable") {
    return "Not available yet.";
  }
  return result.message?.trim() || "Not available yet.";
}

export function jobsFromPayload(
  payload: unknown,
  now: Date = new Date(),
): AgentJobRow[] {
  const rec = isRecord(payload) ? payload : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec.jobs)
      ? rec.jobs
      : [];
  const rows: AgentJobRow[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const jobId = str(item.jobId) || str(item.id);
    if (!jobId) continue;
    const prompt = str(item.prompt);
    const schedule = isRecord(item.schedule) ? item.schedule : null;
    const createdAt =
      str(item.createdAt) || createdAtFromJobId(jobId);
    const outcome = formatJobOutcome(
      str(item.lastRunOutcome) || str(item.lastStatus),
    );
    const lastRunAt = str(item.lastRunAt);
    const scheduleState = str(item.scheduleState).toUpperCase();
    const status = str(item.status).toLowerCase();
    const active =
      scheduleState === "ENABLED" ||
      (!scheduleState && status !== "paused");
    rows.push({
      jobId,
      title: jobTitleFromPrompt(prompt),
      prompt,
      cadence: formatJobCadence(str(item.rate), schedule, now),
      runningFor: formatRunningFor(createdAt, now),
      lastRan: lastRunAt ? formatRelativeAgo(lastRunAt, now) : null,
      lastOutcome: outcome.label,
      lastOutcomeKind: outcome.kind,
      active,
      canPause: active,
    });
  }
  return rows;
}

function tokensByModelFrom(value: unknown): AgentUsageModelBar[] {
  const rows: Array<{ model: string; tokens: number }> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isRecord(item)) continue;
      const model = str(item.model) || str(item.name);
      if (!model) continue;
      rows.push({ model, tokens: tokenTotal(item) });
    }
  } else if (isRecord(value)) {
    for (const [model, raw] of Object.entries(value)) {
      if (!model.trim()) continue;
      const tokens = isRecord(raw) ? tokenTotal(raw) : (finiteNumber(raw) ?? 0);
      rows.push({ model: model.trim(), tokens });
    }
  }
  const max = Math.max(0, ...rows.map((r) => r.tokens));
  return rows
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    .map((r) => ({
      ...r,
      pct: max > 0 ? Math.round((r.tokens / max) * 100) : 0,
    }));
}

function skillListFrom(value: unknown): Array<{ skill: string; count: number }> {
  if (!value) return [];
  const rec = isRecord(value) ? value : null;
  const source = rec?.bySkill ?? value;
  const rows: Array<{ skill: string; count: number }> = [];
  if (Array.isArray(source)) {
    for (const item of source) {
      if (!isRecord(item)) continue;
      const skill = str(item.skill);
      const count = finiteNumber(item.count);
      if (!skill || count == null) continue;
      rows.push({ skill, count });
    }
  } else if (isRecord(source)) {
    for (const [skill, countValue] of Object.entries(source)) {
      const count = finiteNumber(countValue);
      if (!skill.trim() || count == null) continue;
      rows.push({ skill: skill.trim(), count });
    }
  }
  return rows.sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)).slice(0, 8);
}

function projectListFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (!isRecord(item)) return "";
      return str(item.title) || str(item.name);
    })
    .filter(Boolean);
}

export function usageFromCompanyTelemetry(
  payload: unknown,
  agentUid: string,
): AgentUsageView | null {
  if (!isRecord(payload)) return null;
  const members = Array.isArray(payload.perMember)
    ? payload.perMember
    : Array.isArray(payload.members)
      ? payload.members
      : [];
  const row = members.find((item) => {
    if (!isRecord(item)) return false;
    const uid = str(item.personUid) || str(item.id);
    return uid === agentUid;
  });
  if (!row || !isRecord(row)) {
    return {
      tokens: 0,
      sessions: 0,
      stories: 0,
      deploys: 0,
      outcomesPerMillion: null,
      dailyTokens: [],
      tokensByModel: [],
      topSkills: [],
      projects: [],
    };
  }
  const totals = isRecord(row.totals) ? row.totals : row;
  const tokensByModel = tokensByModelFrom(
    totals.tokensByModel ?? row.tokensByModel,
  );
  const tokens = tokensByModel.reduce((sum, m) => sum + m.tokens, 0);
  const outcomes = isRecord(row.outcomes) ? row.outcomes : null;
  const byType = outcomes && isRecord(outcomes.byType) ? outcomes.byType : null;
  const trend = Array.isArray(row.trend)
    ? row.trend
        .map((n) => finiteNumber(n))
        .filter((n): n is number => n != null)
    : [];
  return {
    tokens,
    sessions: finiteNumber(row.sessions ?? totals.distinctSessions),
    stories: finiteNumber(byType?.storyCompleted),
    deploys: finiteNumber(byType?.deploySucceeded),
    outcomesPerMillion: finiteNumber(row.efficiency),
    dailyTokens: trend,
    tokensByModel,
    topSkills: skillListFrom(row.skills ?? totals.skills),
    projects: projectListFrom(row.activeProjects),
  };
}

export function ownerLabelFromPayload(
  payload: unknown,
  fallback?: string | null,
): string | null {
  const rec = isRecord(payload) ? payload : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec.owners)
      ? rec.owners
      : [];
  const active = list
    .filter(isRecord)
    .filter((row) => str(row.status).toLowerCase() !== "revoked");
  const creator = active.find((row) => str(row.kind).toLowerCase() === "creator");
  const pick = creator ?? active[0];
  if (!pick) return fallback?.trim() || null;
  return (
    str(pick.displayName) ||
    str(pick.email) ||
    str(pick.personUid) ||
    fallback?.trim() ||
    null
  );
}

export function ownersIncludePerson(
  payload: unknown,
  personUid: string | null | undefined,
): boolean {
  const uid = (personUid ?? "").trim();
  if (!uid) return false;
  const rec = isRecord(payload) ? payload : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec.owners)
      ? rec.owners
      : [];
  return list.some((row) => {
    if (!isRecord(row)) return false;
    if (str(row.personUid) !== uid) return false;
    const status = str(row.status).toLowerCase();
    return status === "active" || status === "creator" || !status;
  });
}

function profileFrom(value: unknown): {
  displayName: string;
  description: string;
  avatarUrl: string | null;
} {
  const rec = isRecord(value) ? value : {};
  return {
    displayName: str(rec.displayName) || str(rec.name),
    description: str(rec.description),
    avatarUrl: str(rec.avatarUrl) || null,
  };
}

export function headerFromStatusPayload(
  payload: unknown,
  seed: {
    uid: string;
    displayName: string;
    description?: string | null;
    avatarUrl?: string | null;
    companyUid?: string | null;
    companyNames?: Map<string, string> | Record<string, string>;
  },
): AgentDetailHeader {
  const rec = isRecord(payload) ? payload : {};
  const agent = isRecord(rec.agent) ? rec.agent : rec;
  const setup = isRecord(rec.setupState) ? rec.setupState : null;
  const runtime = isRecord(agent.runtime) ? agent.runtime : null;
  const heartbeat = runtime && isRecord(runtime.lastHeartbeat)
    ? runtime.lastHeartbeat
    : null;
  const components = heartbeat && isRecord(heartbeat.components)
    ? heartbeat.components
    : {};
  const profile = profileFrom(agent.profile);
  const companyUid = str(agent.companyUid) || str(seed.companyUid);
  const companyNames = seed.companyNames;
  const companyLabel = companyUid
    ? companyNames instanceof Map
      ? companyNames.get(companyUid) ?? companyUid
      : companyNames?.[companyUid] ?? companyUid
    : null;
  const displayName =
    profile.displayName ||
    str(agent.name) ||
    seed.displayName.trim() ||
    seed.uid;
  return {
    uid: str(agent.uid) || seed.uid,
    displayName,
    description: profile.description || str(seed.description),
    status: deriveAgentWorkStatus({
      setupPhase: str(setup?.phase) || str(agent.setupPhase),
      runtimeStatus: str(runtime?.status) || str(agent.agentStatus),
      taskHealth: str(components.task),
    }),
    ownerLabel: null,
    companies: companyLabel ? [companyLabel] : companyUid ? [companyUid] : [],
    avatarUrl: profile.avatarUrl || seed.avatarUrl || null,
    modelLabel: str(agent.codexModel) || null,
    provider: str(agent.provider) || null,
    runtimeStatus: str(runtime?.status) || null,
    canManage: true,
  };
}

export function headerFromMobileRoster(
  payload: unknown,
  seed: {
    uid: string;
    displayName: string;
    description?: string | null;
    avatarUrl?: string | null;
    companyUid?: string | null;
    companyNames?: Map<string, string> | Record<string, string>;
  },
): AgentDetailHeader | null {
  const rec = isRecord(payload) ? payload : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(rec.agents)
      ? rec.agents
      : [];
  const row = list.find((item) => {
    if (!isRecord(item)) return false;
    const uid = str(item.agentUid) || str(item.uid);
    return uid === seed.uid;
  });
  if (!row || !isRecord(row)) return null;
  const companyUid = str(row.companyUid) || str(seed.companyUid);
  const companyNames = seed.companyNames;
  const companyLabel = companyUid
    ? companyNames instanceof Map
      ? companyNames.get(companyUid) ?? companyUid
      : companyNames?.[companyUid] ?? companyUid
    : null;
  return {
    uid: str(row.agentUid) || str(row.uid) || seed.uid,
    displayName:
      str(row.displayName) || str(row.name) || seed.displayName || seed.uid,
    description: str(row.description) || str(seed.description),
    status: deriveAgentWorkStatus({
      setupPhase: str(row.setupPhase) || str(row.status),
      runtimeStatus: str(row.status),
    }),
    ownerLabel: null,
    companies: companyLabel ? [companyLabel] : companyUid ? [companyUid] : [],
    avatarUrl: seed.avatarUrl || null,
    modelLabel: null,
    provider: null,
    runtimeStatus: str(row.status) || null,
    canManage: false,
  };
}

export function seedHeader(seed: {
  uid: string;
  displayName: string;
  description?: string | null;
  avatarUrl?: string | null;
  companyUid?: string | null;
  companyNames?: Map<string, string> | Record<string, string>;
}): AgentDetailHeader {
  const companyUid = str(seed.companyUid);
  const companyNames = seed.companyNames;
  const companyLabel = companyUid
    ? companyNames instanceof Map
      ? companyNames.get(companyUid) ?? companyUid
      : companyNames?.[companyUid] ?? companyUid
    : null;
  return {
    uid: seed.uid,
    displayName: seed.displayName.trim() || seed.uid,
    description: str(seed.description),
    status: "IDLE",
    ownerLabel: null,
    companies: companyLabel ? [companyLabel] : companyUid ? [companyUid] : [],
    avatarUrl: seed.avatarUrl ?? null,
    modelLabel: null,
    provider: null,
    runtimeStatus: null,
    canManage: false,
  };
}
