/**
 * Company Bots table: one row per bot, a status ladder, and a column model
 * that drops the least useful columns first as the table gets narrower.
 * Pure data; BotsPage paints it.
 */

import type { LocalBotRow } from "@hq/platform";
import type { CloudBotRow } from "../settings/cloud-bots.js";

/**
 * One status per bot, first match wins:
 * error (setup or process failed) → waiting (still setting up, or held) →
 * ready (running, online, or set up with a recent heartbeat) → offline.
 */
export const BOT_STATUSES = ["ready", "waiting", "error", "offline"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const BOT_STATUS_LABEL: Record<BotStatus, string> = {
  ready: "Ready",
  waiting: "Waiting",
  error: "Error",
  offline: "Offline",
};

/** A cloud bot with no heartbeat for this long counts as offline. */
export const CLOUD_STALE_MS = 30 * 60 * 1000;

const WAITING_PHASES = new Set(["provisioning", "pending", "launching", "awaiting-signin", "awaiting-auth", "deprovisioning"]);

export function localBotStatus(bot: Pick<LocalBotRow, "state" | "online" | "busy" | "promotionHold">): BotStatus {
  const state = (bot.state ?? "").trim().toLowerCase();
  if (state === "failed") return "error";
  if (bot.promotionHold) return "waiting";
  if (state === "running" || bot.online === true || bot.busy === true) return "ready";
  return "offline";
}

export function cloudBotStatus(
  bot: { phase: string; status: string },
  lastSeenAt: string | null,
  now: number,
): BotStatus {
  const phase = bot.phase.trim().toLowerCase();
  if (phase === "failed" || phase === "error") return "error";
  if (WAITING_PHASES.has(phase) || bot.status === "PROVISIONING") return "waiting";
  if (bot.status === "WORKING") return "ready";
  const seen = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (Number.isFinite(seen) && now - seen > CLOUD_STALE_MS) return "offline";
  return "ready";
}

export interface BotTableRow {
  uid: string;
  name: string;
  /** The bot's handle (folder name or slug), when it differs from the name. */
  handle: string | null;
  avatarUrl: string | null;
  kind: "local" | "cloud";
  /** "This Mac", "Cloud" or "External". */
  host: string;
  /** "Claude · opus", "Codex", … ; null when nothing is reported. */
  engine: string | null;
  owner: string | null;
  role: string | null;
  /** What it is doing now, in words; null when idle or unknown. */
  activity: string | null;
  live: boolean;
  lastSeenAt: string | null;
  status: BotStatus;
  canPause: boolean;
}

const RUNTIME_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", hermes: "Hermes", openclaw: "OpenClaw" };

export function engineLabel(runtime: string | null | undefined, model?: string | null): string | null {
  const key = (runtime ?? "").trim().toLowerCase();
  const name = key ? (RUNTIME_LABEL[key] ?? key.charAt(0).toUpperCase() + key.slice(1)) : "";
  const m = (model ?? "").trim();
  if (name && m) return `${name} · ${m}`;
  return name || m || null;
}

function roleText(role: unknown): string | null {
  const r = typeof role === "string" ? role.trim().toLowerCase() : "";
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : null;
}

export function localTableRow(bot: LocalBotRow, ownerName: string | null): BotTableRow {
  const name = bot.displayName?.trim() || bot.name;
  const status = localBotStatus(bot);
  return {
    uid: bot.agentUid,
    name,
    handle: name !== bot.name ? bot.name : null,
    avatarUrl: null,
    kind: "local",
    host: "This Mac",
    engine: engineLabel(bot.runtime, bot.model),
    owner: ownerName?.trim() || null,
    role: null,
    activity: bot.busy ? "Answering a message" : null,
    live: bot.state === "running" || bot.online === true || bot.busy === true,
    lastSeenAt: bot.busy ? (bot.busySince ?? bot.lastHeartbeatAt) : bot.lastHeartbeatAt,
    status,
    canPause: true,
  };
}

/** Extra roster fields the mobile roster already returns next to CloudBotRow's. */
export interface CloudRosterExtras {
  handle: string | null;
  runtimeKind: string | null;
  title: string | null;
  membershipRole: string | null;
  lastActiveAt: string | null;
  external: boolean;
}

export function cloudRosterExtras(payload: unknown): Map<string, CloudRosterExtras> {
  const rec = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(payload) ? payload : Array.isArray(rec.agents) ? rec.agents : [];
  const out = new Map<string, CloudRosterExtras>();
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const uid = s(item.agentUid) ?? s(item.uid);
    if (!uid || out.has(uid)) continue;
    out.set(uid, {
      handle: s(item.slug) ?? s(item.name),
      runtimeKind: s(item.runtimeKind),
      title: s(item.title),
      membershipRole: s(item.membershipRole),
      lastActiveAt: s(item.lastActiveAt),
      external: !!item.external && typeof item.external === "object",
    });
  }
  return out;
}

export function cloudTableRow(bot: CloudBotRow, extras: CloudRosterExtras | undefined, now: number): BotTableRow {
  const lastSeenAt = extras?.lastActiveAt ?? null;
  const handle = extras?.handle && extras.handle !== bot.displayName ? extras.handle : null;
  return {
    uid: bot.uid,
    name: bot.displayName,
    handle,
    avatarUrl: bot.avatarUrl,
    kind: "cloud",
    host: extras?.external ? "External" : "Cloud",
    engine: engineLabel(extras?.runtimeKind ?? null),
    owner: null,
    role: roleText(extras?.membershipRole),
    activity: bot.status === "WORKING" ? "Working" : bot.status === "PROVISIONING" && bot.phase !== "failed" ? "Setting up" : (extras?.title ?? null),
    live: bot.status === "WORKING",
    lastSeenAt,
    status: cloudBotStatus(bot, lastSeenAt, now),
    canPause: bot.canManage,
  };
}

/** "now", "4 min ago", "3 h ago", "2 d ago", else a short date. */
export function lastSeenLabel(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d <= 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export type BotSortKey = "status" | "lastSeen" | "name";
export type SortDir = "asc" | "desc";

const RANK: Record<BotStatus, number> = { ready: 0, waiting: 1, error: 2, offline: 3 };

function seen(row: BotTableRow): number {
  const t = row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Sort rows. Status ascending follows the ladder (ready first); last seen
 * descending puts the most recent first. Live bots always lead when
 * `liveFirst` is set (the Live filter). Ties fall back to name.
 */
export function sortBotRows(
  rows: readonly BotTableRow[],
  key: BotSortKey,
  dir: SortDir,
  opts: { liveFirst?: boolean } = {},
): BotTableRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const byName = (a: BotTableRow, b: BotTableRow) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => {
    if (opts.liveFirst && a.live !== b.live) return a.live ? -1 : 1;
    let c = 0;
    if (key === "status") c = (RANK[a.status] - RANK[b.status]) * sign || seen(b) - seen(a);
    else if (key === "lastSeen") c = (seen(a) - seen(b)) * sign;
    else c = byName(a, b) * sign;
    if (Number.isNaN(c)) c = 0;
    return c || byName(a, b);
  });
}

export type BotColumnKey =
  | "avatar"
  | "name"
  | "kind"
  | "host"
  | "engine"
  | "owner"
  | "role"
  | "activity"
  | "presence"
  | "lastSeen"
  | "status";

export interface BotColumn {
  key: BotColumnKey;
  label: string;
  /** CSS grid track. */
  track: string;
  /** Narrowest width the track needs, px. */
  min: number;
  /** Lower drops later; 0 never drops. */
  priority: number;
  sortable?: BotSortKey;
  /** Hidden when no row has a value for it. */
  optional?: (row: BotTableRow) => boolean;
}

/** Display order, left to right. */
export const BOT_COLUMNS: readonly BotColumn[] = [
  { key: "avatar", label: "", track: "24px", min: 24, priority: 0 },
  { key: "name", label: "Name", track: "minmax(140px, 2fr)", min: 140, priority: 0 },
  { key: "kind", label: "Kind", track: "56px", min: 56, priority: 6 },
  { key: "host", label: "Host", track: "72px", min: 72, priority: 7 },
  { key: "engine", label: "Engine", track: "minmax(96px, 1fr)", min: 96, priority: 4, optional: (r) => !!r.engine },
  { key: "owner", label: "Owner", track: "minmax(96px, 1fr)", min: 96, priority: 8, optional: (r) => !!r.owner },
  { key: "role", label: "Role", track: "64px", min: 64, priority: 9, optional: (r) => !!r.role },
  { key: "activity", label: "Activity", track: "minmax(110px, 1.4fr)", min: 110, priority: 3, optional: (r) => !!r.activity },
  { key: "presence", label: "Presence", track: "64px", min: 64, priority: 5 },
  { key: "lastSeen", label: "Last seen", track: "80px", min: 80, priority: 2, sortable: "lastSeen" },
  { key: "status", label: "Status", track: "84px", min: 84, priority: 1, sortable: "status" },
];

export const BOT_COLUMN_GAP = 12;

/**
 * Columns that fit `width` px of row (padding already removed). Columns no
 * row has data for are left out; then the highest priority numbers drop
 * until the minimum widths fit.
 */
export function visibleBotColumns(width: number, rows: readonly BotTableRow[]): BotColumn[] {
  let cols = BOT_COLUMNS.filter((c) => !c.optional || rows.some(c.optional));
  const need = (list: readonly BotColumn[]) => list.reduce((sum, c) => sum + c.min, 0) + BOT_COLUMN_GAP * Math.max(0, list.length - 1);
  while (need(cols) > width) {
    const drop = cols.reduce<BotColumn | null>((worst, c) => (c.priority > 0 && (!worst || c.priority > worst.priority) ? c : worst), null);
    if (!drop) break;
    cols = cols.filter((c) => c !== drop);
  }
  return cols;
}

export function gridTemplate(cols: readonly BotColumn[]): string {
  return cols.map((c) => c.track).join(" ");
}
