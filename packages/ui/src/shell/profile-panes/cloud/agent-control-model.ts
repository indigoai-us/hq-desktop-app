/**
 * Reads the cloud bot control API's answers into the views the tabbed pane
 * draws. Every reader is defensive: a list may come bare or wrapped
 * (`{ routines: [...] }`), and a missing field reads as empty, never as a
 * crash.
 */

import type {
  AdapterFailure,
  AgentControlAgent,
  AgentControlBrain,
  AgentControlChannel,
  AgentControlChannelKind,
  AgentControlKnowledgeDoc,
  AgentControlKnowledgeFile,
  AgentControlMemoryDoc,
  AgentControlMemoryEntry,
  AgentControlPersona,
  AgentControlRoutine,
  AgentControlView,
} from "@hq/platform";

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A list sent bare, or wrapped in `{ [key]: [...] }` or `{ items: [...] }`. */
function list(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value;
  const r = rec(value);
  if (!r) return [];
  if (Array.isArray(r[key])) return r[key] as unknown[];
  if (Array.isArray(r.items)) return r.items as unknown[];
  return [];
}

/** An object sent bare, or wrapped in `{ [key]: {...} }`. */
function unwrap(value: unknown, key: string): Rec | null {
  const r = rec(value);
  if (!r) return null;
  return rec(r[key]) ?? r;
}

export const CHANNEL_KINDS: readonly AgentControlChannelKind[] = ["hq", "slack", "telegram", "email"];

export const CHANNEL_LABEL: Record<AgentControlChannelKind, string> = {
  hq: "HQ messages",
  slack: "Slack",
  telegram: "Telegram",
  email: "Email",
};

function isChannelKind(value: unknown): value is AgentControlChannelKind {
  return typeof value === "string" && (CHANNEL_KINDS as readonly string[]).includes(value);
}

export function agentFromPayload(value: unknown, fallback: { uid: string; displayName: string; online: boolean }): AgentControlAgent {
  const r = unwrap(value, "agent");
  return {
    uid: str(r?.uid) || fallback.uid,
    displayName: str(r?.displayName) || fallback.displayName,
    title: str(r?.title),
    avatarUrl: strOrNull(r?.avatarUrl),
    online: typeof r?.online === "boolean" ? r.online : fallback.online,
    lastSeenAt: strOrNull(r?.lastSeenAt),
  };
}

/** Channels in a fixed order. A kind the server did not list reads "Not connected". */
export function channelsFromPayload(value: unknown): AgentControlChannel[] {
  const byKind = new Map<AgentControlChannelKind, AgentControlChannel>();
  for (const item of list(value, "channels")) {
    const r = rec(item);
    if (!r || !isChannelKind(r.kind)) continue;
    const status = r.status === "connected" || r.status === "error" ? r.status : "not_connected";
    byKind.set(r.kind, {
      kind: r.kind,
      enabled: r.enabled === true,
      status,
      detail: strOrNull(r.detail),
    });
  }
  return CHANNEL_KINDS.map(
    (kind) => byKind.get(kind) ?? { kind, enabled: false, status: "not_connected", detail: null },
  );
}

export function routineFromPayload(value: unknown): AgentControlRoutine | null {
  const r = unwrap(value, "routine");
  if (!r) return null;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name) || "Untitled routine",
    schedule: str(r.schedule),
    timezone: strOrNull(r.timezone),
    prompt: str(r.prompt),
    enabled: r.enabled !== false,
    lastRunAt: strOrNull(r.lastRunAt),
    nextRunAt: strOrNull(r.nextRunAt),
    lastStatus: strOrNull(r.lastStatus),
  };
}

export function routinesFromPayload(value: unknown): AgentControlRoutine[] {
  return list(value, "routines")
    .map(routineFromPayload)
    .filter((r): r is AgentControlRoutine => r !== null);
}

export function personaFromPayload(value: unknown): AgentControlPersona {
  const r = unwrap(value, "persona");
  return {
    displayName: str(r?.displayName),
    title: str(r?.title),
    description: str(r?.description),
    instructions: str(r?.instructions),
    instructionsPath: strOrNull(r?.instructionsPath),
    updatedAt: strOrNull(r?.updatedAt),
  };
}

function memoryEntryFromPayload(value: unknown): AgentControlMemoryEntry | null {
  const r = rec(value);
  const id = str(r?.id);
  if (!r || !id) return null;
  return { id, title: str(r.title) || id, preview: str(r.preview), updatedAt: strOrNull(r.updatedAt) };
}

function knowledgeFileFromPayload(value: unknown): AgentControlKnowledgeFile | null {
  const r = rec(value);
  const path = str(r?.path);
  if (!r || !path) return null;
  return { path, size: num(r.size), updatedAt: strOrNull(r.updatedAt) };
}

export function brainFromPayload(value: unknown): AgentControlBrain {
  const r = unwrap(value, "brain");
  const models = Array.isArray(r?.availableModels)
    ? (r!.availableModels as unknown[]).map((m) => (typeof m === "string" ? m : str(rec(m)?.id))).filter(Boolean)
    : [];
  return {
    model: str(r?.model),
    provider: strOrNull(r?.provider),
    availableModels: models,
    memory: list(r?.memory, "memory").map(memoryEntryFromPayload).filter((m): m is AgentControlMemoryEntry => m !== null),
    knowledge: list(r?.knowledge, "knowledge")
      .map(knowledgeFileFromPayload)
      .filter((k): k is AgentControlKnowledgeFile => k !== null),
  };
}

export function memoryDocFromPayload(value: unknown, id: string): AgentControlMemoryDoc {
  const r = unwrap(value, "memory");
  return {
    id: str(r?.id) || id,
    title: str(r?.title) || str(r?.id) || id,
    content: str(r?.content),
    updatedAt: strOrNull(r?.updatedAt),
  };
}

export function knowledgeDocFromPayload(value: unknown, path: string): AgentControlKnowledgeDoc {
  const r = unwrap(value, "file");
  return {
    path: str(r?.path) || path,
    content: str(r?.content),
    size: num(r?.size),
    updatedAt: strOrNull(r?.updatedAt),
  };
}

export function controlViewFromPayload(
  value: unknown,
  fallback: { uid: string; displayName: string; online: boolean },
): AgentControlView {
  const r = rec(value);
  return {
    agent: agentFromPayload(r?.agent ?? null, fallback),
    channels: channelsFromPayload(r?.channels ?? []),
    routines: routinesFromPayload(r?.routines ?? []),
    persona: personaFromPayload(r?.persona ?? null),
    brain: brainFromPayload(r?.brain ?? null),
    source: r?.source === "snapshot" ? "snapshot" : "live",
    fetchedAt: strOrNull(r?.fetchedAt),
  };
}

const OFFLINE_CODE = /OFFLINE|UNREACHABLE|BOX_DOWN|NOT_RUNNING/i;

export interface ControlError {
  offline: boolean;
  message: string;
}

/**
 * What a refused control request says on screen. The server's own sentence
 * when it sent one with a code; plain copy for a transport failure or a bare
 * status, whose text is meant for the log.
 */
export function controlError(res: AdapterFailure): ControlError {
  const code = res.code ?? "";
  const offline = OFFLINE_CODE.test(code);
  const fromServer = code && !/^http-|^network$|^bad-json$|^http-error$/.test(code) ? (res.message ?? "").trim() : "";
  if (fromServer) return { offline, message: fromServer };
  if (offline) return { offline, message: "This bot is offline. Try again when it's back." };
  if (code === "network") return { offline, message: "Could not reach HQ. Check your connection and try again." };
  if (res.status === 403 || code === "http-403") {
    return { offline, message: "Only the bot's owners and company admins can change this." };
  }
  if (res.status === 404 || code === "http-404") {
    return { offline, message: "This needs a newer HQ server. Try again later." };
  }
  return { offline, message: "Something went wrong. Try again." };
}

const DAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function intIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** A cron schedule in plain words ("Weekdays at 9:00"); anything unusual reads as itself. */
export function scheduleInWords(schedule: string): string {
  const raw = schedule.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw || "No schedule";
  const [mi, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  if (mon !== "*") return raw;
  const every = /^\*\/(\d+)$/;
  if (hr === "*" && dom === "*" && dow === "*") {
    if (mi === "*") return "Every minute";
    const step = every.exec(mi);
    if (step) return `Every ${step[1]} minutes`;
    if (intIn(mi, 0, 59) === 0) return "Every hour";
    if (intIn(mi, 0, 59) !== null) return `Every hour at :${mi.padStart(2, "0")}`;
    return raw;
  }
  const minute = intIn(mi, 0, 59);
  if (minute === null) return raw;
  const hourStep = every.exec(hr);
  if (hourStep && dom === "*" && dow === "*") return `Every ${hourStep[1]} hours`;
  const hour = intIn(hr, 0, 23);
  if (hour === null) return raw;
  const at = clock(hour, minute);
  if (dom === "*" && dow === "*") return `Daily at ${at}`;
  if (dom === "*") {
    if (dow === "1-5") return `Weekdays at ${at}`;
    if (dow === "0,6" || dow === "6,0") return `Weekends at ${at}`;
    const days = dow.split(",").map((d) => intIn(d, 0, 7));
    if (days.some((d) => d === null)) return raw;
    const idx = days.map((d) => (d as number) % 7);
    if (idx.length === 1) return `${DAY_NAMES[idx[0]!]} at ${at}`;
    return `${idx.map((d) => DAY_SHORT[d]).join(", ")} at ${at}`;
  }
  const day = intIn(dom, 1, 31);
  if (day !== null && dow === "*") return `Monthly on day ${day} at ${at}`;
  return raw;
}

export const SCHEDULE_PRESETS: ReadonlyArray<{ id: string; label: string; cron: string }> = [
  { id: "hourly", label: "Hourly", cron: "0 * * * *" },
  { id: "daily", label: "Daily", cron: "0 9 * * *" },
  { id: "weekdays", label: "Weekdays", cron: "0 9 * * 1-5" },
  { id: "weekly", label: "Weekly", cron: "0 9 * * 1" },
];

/** "in 3h", "2d ago", "just now". Null for a missing or unreadable time. */
export function relativeTime(iso: string | null, now: number = Date.now()): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const diff = at - now;
  const abs = Math.abs(diff);
  const min = 60_000;
  if (abs < min) return "just now";
  const units: Array<[number, string]> = [
    [24 * 60 * min, "d"],
    [60 * min, "h"],
    [min, "m"],
  ];
  const [size, unit] = units.find(([s]) => abs >= s)!;
  const n = Math.floor(abs / size);
  return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A knowledge path the box will take: relative, no `..`, no empty parts. */
export function validKnowledgePath(path: string): boolean {
  const p = path.trim();
  if (!p || p.startsWith("/") || p.includes("\\")) return false;
  return p.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** What the brain pop-up shows: an entry on the box, or a new one. */
export type BrainDocTarget =
  | { kind: "memory"; id: string; title: string }
  | { kind: "knowledge"; path: string }
  | { kind: "new-memory" }
  | { kind: "new-knowledge" };
