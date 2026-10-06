/**
 * Pure model for the chat-first unified conversation sidebar (US-003).
 *
 * No Svelte / DOM — unit-tested with real dates. Normalizes channels + DMs into
 * rows, groups by day (TODAY / YESTERDAY / weekday / LAST WEEK collapse),
 * filters by company scope + show kind, sorts, and persists pins.
 */

import {
  channelDisplayName,
  isCompanyHomeChannel,
  mergeDirectoryUnread,
  type Channel,
  type ChannelMembership,
  type ChannelParticipant,
} from "./channels";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { isAgentUid } from "./agent-thinking";
import { agentAvatarFor } from "./messaging/agent-avatars";
import { paintableAvatarSrc } from "../avatars/csp-image-src.js";
import { isSetupChannel } from "./setup-channel";
import type { NotifyLevel } from "./notify-level";

// ── Row shape ────────────────────────────────────────────────────────────────

export type ConversationKind = "channel" | "dm" | "group";

export interface ConversationRow {
  /** Stable id: `ch:<channelId>` or `dm:<personUid>`. */
  id: string;
  kind: ConversationKind;
  title: string;
  /** Company scope when known; null for personal / pure DMs / group DMs. */
  companyUid: string | null;
  /**
   * Owning company's presigned website favicon, when the server sent one.
   * Absent → the row draws the building glyph. Company-scoped rows only.
   */
  iconUrl?: string | null;
  /** Numeric unread — channels, and DMs when server pairUnreads is present. */
  unreadCount?: number;
  /** Dot indicator for activity (DMs without numeric unread / optional channel activity). */
  unreadDot: boolean;
  /** Epoch-ms of most recent activity (0 when unknown). */
  lastActivityAt: number;
  /**
   * Epoch-ms of the most recent message a person typed (mesh, bot, and
   * system rows excluded). Present only when the server sent one. Read only
   * when the `desktop.human-only-conversations` flag is on. See
   * `rowHumanRecencyState` for the three states this and `hasHumanMessage`
   * encode.
   */
  lastHumanMessageAt?: number;
  /**
   * `false` when the server knows the conversation holds no human message.
   * Never `true`. Absent with no `lastHumanMessageAt` means unknown, and the
   * sidebar then falls back to `lastActivityAt`.
   */
  hasHumanMessage?: false;
  /**
   * Epoch-ms creation time. Set only on rows known to hold no human message,
   * where it is the recency key, on the same timeline as human times. Never
   * used as activity.
   */
  createdAt?: number;
  /**
   * Epoch-ms of the most recent DURABLE MESSAGE, with no creation-time
   * fallback (0 when the conversation has never carried one). The directory
   * sends `lastActivityAt: null` for a channel with no messages, so this
   * separates "exists" from "has been talked in" — which `lastActivityAt`
   * cannot, since it falls back to `createdAt` for ordering.
   */
  messageActivityAt?: number;
  pinned: boolean;
  /** Member count for group DMs (avatar stack). */
  memberCount?: number;
  /** Group-DM members for labels/avatars. */
  members?: ChannelParticipant[];
  /** Underlying channel id when kind is channel|group. */
  channelId?: string;
  /** Work-mesh / board project slug when the directory row carried one. */
  projectId?: string | null;
  /**
   * Underlying channel scope when kind is channel ("project" | "company" |
   * "personal" | server-defined). Personal-scope channels must never surface
   * under the project filters.
   */
  channelScope?: string;
  /**
   * True when the underlying channel is THE company home channel (one per
   * company, created at genesis, named after the company slug). Only home
   * channels carry Office/CompanyHero/company-settings chrome; other
   * `channelScope === "company"` rows are plain team channels. See
   * `isCompanyHomeChannel()` in channels.ts for the resolution rule.
   */
  isCompanyHome?: boolean;
  /** Underlying person uid when kind is dm. */
  personUid?: string;
  email?: string | null;
  /**
   * US-021: an org owner/admin browse-only row — a project channel the caller
   * is NOT a member of, surfaced only under the "All company projects" filter.
   */
  browseOnly?: boolean;
  /**
   * Caller's membership in the underlying channel (`joined` / `invited` /
   * `none`). Absent on DM rows and older payloads (treated as `joined` —
   * the member directory only returns the caller's own channels).
   */
  membership?: ChannelMembership;
  /**
   * Caller's notification level for the underlying channel. Drives the header
   * bell and the sidebar muted indicator. Absent on DM rows, browse-only rows,
   * and older payloads.
   */
  notifyLevel?: NotifyLevel | null;
  /** Channel creator uid, when known. */
  createdBy?: string | null;
  /** A newly created cloud bot that is still waking up. */
  wakingBot?: {
    agentUid: string;
    progress: number;
  } | null;
  /** A cancelled cloud bot that still exists: being removed, or not removed. */
  removingBot?: {
    agentUid: string;
    phase: "removing" | "failed";
  } | null;
}

export interface WakingSidebarBot {
  agentUid: string;
  channelId: string;
  companyUid: string;
  name: string;
  startedAt: number;
  progress: number;
}

/**
 * Keeps a just-created bot visible before its conversation reaches the
 * directory. The bot's conversation is its direct message: the real directory
 * row replaces this optimistic row by id. A channel an older server made for
 * the bot is left out, because the person talks to the bot in the direct
 * message and nowhere else.
 */
export function withWakingBotRow(
  rows: readonly ConversationRow[],
  bot: WakingSidebarBot | null,
): ConversationRow[] {
  if (!bot || (!bot.agentUid && !bot.channelId)) return [...rows];
  const wakingBot = { agentUid: bot.agentUid, progress: bot.progress };
  if (bot.agentUid) {
    const visible = bot.channelId
      ? rows.filter((row) => row.channelId !== bot.channelId)
      : [...rows];
    const known = visible.find((row) => row.kind === "dm" && row.personUid === bot.agentUid);
    if (known) {
      return visible.map((row) => row === known ? { ...row, wakingBot } : row);
    }
    return [{
      id: `dm:${bot.agentUid}`,
      kind: "dm",
      title: bot.name || "Your bot",
      companyUid: null,
      unreadDot: false,
      lastActivityAt: bot.startedAt,
      pinned: false,
      personUid: bot.agentUid,
      wakingBot,
    }, ...visible];
  }
  // No bot id (a server that named only the channel): keep the channel row.
  const id = `ch:${bot.channelId}`;
  const known = rows.find((row) => row.id === id);
  if (known) {
    return rows.map((row) => row.id === id ? { ...row, wakingBot } : row);
  }
  return [{
    id,
    kind: "channel",
    title: bot.name || "Your bot",
    companyUid: bot.companyUid || null,
    unreadDot: false,
    lastActivityAt: bot.startedAt,
    pinned: false,
    channelId: bot.channelId,
    channelScope: "company",
    wakingBot,
  }, ...rows];
}

/** A cancelled bot, as the sidebar needs to know it. */
export interface CancelledSidebarBot {
  agentUid: string;
  channelId: string;
  name: string;
  phase: "stopping" | "removing" | "removed" | "failed" | "not-created";
  /** True when the bot had a row before Cancel. */
  hadRow: boolean;
  /** When Cancel was pressed. */
  startedAt: number;
}

/**
 * Rows for cancelled bots. The list never says more than the server did:
 *
 * - removed: the bot's rows are left out, even if an older directory answer
 *   still lists them.
 * - removing: a bot that already had a row keeps it, marked, until the server
 *   says it is gone. A bot cancelled before it had a row gets none.
 * - failed: the bot still exists, so it has a marked row either way.
 */
export function withCancelledBotRows(
  rows: readonly ConversationRow[],
  bots: readonly CancelledSidebarBot[],
  removedAgentUids: readonly string[] = [],
): ConversationRow[] {
  const removed = new Set(removedAgentUids);
  let next = removed.size
    ? rows.filter((row) => !(row.kind === "dm" && row.personUid && removed.has(row.personUid)))
    : [...rows];
  for (const bot of bots) {
    if (!bot.agentUid && !bot.channelId) continue;
    const isBotRow = (row: ConversationRow): boolean =>
      (!!bot.agentUid && row.kind === "dm" && row.personUid === bot.agentUid) ||
      (!!bot.channelId && row.channelId === bot.channelId);
    if (bot.phase === "removed") {
      next = next.filter((row) => !isBotRow(row));
      continue;
    }
    if (bot.phase !== "removing" && bot.phase !== "failed") continue;
    const shown = !!bot.agentUid && (bot.phase === "failed" || bot.hadRow);
    if (!shown) {
      next = next.filter((row) => !isBotRow(row));
      continue;
    }
    const removingBot = { agentUid: bot.agentUid, phase: bot.phase };
    const visible = bot.channelId
      ? next.filter((row) => row.channelId !== bot.channelId)
      : next;
    const known = visible.find((row) => row.kind === "dm" && row.personUid === bot.agentUid);
    next = known
      ? visible.map((row) => row === known ? { ...row, wakingBot: null, removingBot } : row)
      : [{
          id: `dm:${bot.agentUid}`,
          kind: "dm",
          title: bot.name || "Your bot",
          companyUid: null,
          unreadDot: false,
          lastActivityAt: bot.startedAt,
          pinned: false,
          personUid: bot.agentUid,
          removingBot,
        }, ...visible];
  }
  return next;
}

export const BOT_SETUP_CHANNELS_STORAGE_KEY = "hq.chat.botSetupChannels.v1";

/**
 * Channels an older server created alongside a bot made in the new bot flow.
 * The flow's conversation is the direct message, so these stay off the list.
 */
export function loadBotSetupChannels(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(BOT_SETUP_CHANNELS_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
  } catch {
    return [];
  }
}

export function rememberBotSetupChannel(
  channelIds: readonly string[],
  channelId: string,
  storage: Pick<Storage, "setItem"> | null | undefined,
): string[] {
  const id = channelId.trim();
  if (!id || channelIds.includes(id)) return [...channelIds];
  const next = [id, ...channelIds].slice(0, 200);
  try {
    storage?.setItem(BOT_SETUP_CHANNELS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
  return next;
}

export function withoutBotSetupChannels(
  rows: readonly ConversationRow[],
  channelIds: readonly string[],
): ConversationRow[] {
  if (channelIds.length === 0) return [...rows];
  const hidden = new Set(channelIds);
  return rows.filter((row) => !(row.channelId && hidden.has(row.channelId)));
}

/**
 * Metadata that can arrive after a deep-link's synthetic conversation row.
 * Activity and local presentation state (`unreadCount`, `unreadDot`,
 * `lastActivityAt`, `pinned`) are deliberately excluded: they fluctuate and
 * must never make initial-row reconciliation replace a user's selection.
 */
const CONVERSATION_ROW_RICHNESS_FIELDS = [
  "companyUid",
  // Metadata (arrives with the live directory row, absent on a deep-link
  // stub), so it belongs here — otherwise a stub carrying no icon would look
  // "not strictly richer" once the real row arrived with one.
  "iconUrl",
  "projectId",
  "channelId",
  "channelScope",
  "isCompanyHome",
  "title",
  "personUid",
  "email",
  "memberCount",
  "members",
  "browseOnly",
  "membership",
] as const satisfies readonly (keyof ConversationRow)[];

function hasConversationRowValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * True only when `next` is the same conversation and fills metadata gaps
 * without dropping any known metadata. This monotone rule prevents the shell
 * from oscillating between a deep-link stub and a partial live directory row.
 */
export function isStrictlyRicherConversationRow(
  next: ConversationRow,
  current: ConversationRow,
): boolean {
  if (next.id !== current.id || next.kind !== current.kind) return false;

  let fillsGap = false;
  for (const field of CONVERSATION_ROW_RICHNESS_FIELDS) {
    const currentHasValue = hasConversationRowValue(current[field]);
    const nextHasValue = hasConversationRowValue(next[field]);
    if (currentHasValue && !nextHasValue) return false;
    if (!currentHasValue && nextHasValue) fillsGap = true;
  }
  return fillsGap;
}

/** Company option for the scope pill (order preserved from caller). */
export interface ScopeCompany {
  companyUid: string;
  label: string;
  /** Configured company slug (the `companies/<slug>/` folder). Never derive it from `label`. */
  slug?: string | null;
  /** Presigned company icon, when the membership row carried one. */
  iconUrl?: string | null;
}

export type CompanyScope = "all" | "personal" | string;

export type SortMode = "recent" | "type";
/**
 * `mine` (default) is member project/chat channels plus DMs the caller is in.
 * `company-projects` (US-021) is the org owner/admin-only view: member project
 * channels PLUS browse-only rows for other members' project channels.
 */
export type ShowFilter =
  "mine" | "all" | "projects" | "dms" | "company-projects";

/** Default Show filter for users with no persisted choice. */
export const DEFAULT_SHOW_FILTER: ShowFilter = "mine";

const SHOW_FILTER_VALUES: readonly ShowFilter[] = [
  "mine",
  "all",
  "projects",
  "dms",
  "company-projects",
];

export function isShowFilter(value: unknown): value is ShowFilter {
  return (
    typeof value === "string" &&
    (SHOW_FILTER_VALUES as readonly string[]).includes(value)
  );
}

export interface DaySection {
  /** Stable key for {#each}. */
  key: string;
  /** Uppercase micro-label, e.g. "TODAY · AUG 12", "YESTERDAY", "MONDAY". */
  label: string;
  rows: ConversationRow[];
}

export interface GroupedConversations {
  pinned: ConversationRow[];
  /** Day sections for activity within the last 7 days (excluding older). */
  sections: DaySection[];
  /** Rows older than 7 days — collapsed under LAST WEEK until expanded. */
  lastWeek: ConversationRow[];
  /** Full filtered list (for "Show all history…" view). */
  all: ConversationRow[];
}

export const PINS_STORAGE_KEY = "hq.chat.pins";
export const CONVERSATION_CACHE_KEY = "hq.chat.conversation-cache";
export const DM_DOTS_STORAGE_KEY = "hq.chat.dm-dots";
export const RECENT_DMS_STORAGE_KEY = "hq.chat.recent-dms";
export const SHOW_FILTER_STORAGE_KEY = "hq.chat.show-filter";
/**
 * Set once the user unpins the synthetic #setup channel. The default rail pins
 * #setup for a fresh profile; this flag keeps it unpinned across restarts
 * until the user pins it again.
 */
export const SETUP_PIN_DISMISSED_STORAGE_KEY = "hq.chat.setup-pin-dismissed";
/**
 * Which companies the user has chosen to pin under the sidebar's "Companies"
 * section (each pinned row opens that company's home channel). Stores an
 * array of companyUids using the SAME per-tenant storage as `PINS_STORAGE_KEY`
 * — no absent key or `null` sentinel means "not yet customized, show every
 * company the user belongs to" (see `loadPinnedCompanies`); an explicit empty
 * array means the user deliberately hid every company.
 */
export const PINNED_COMPANIES_STORAGE_KEY = "hq.chat.pinned-companies";

// ── Timestamp helpers ────────────────────────────────────────────────────────

export function parseActivityMs(
  value: string | number | null | undefined,
): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

const WEEKDAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

/** Format a day bucket label at `dayStart` relative to `now`. */
export function daySectionLabel(
  dayStart: number,
  now: number = Date.now(),
): string {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  // Accept any timestamp in the day — normalize to local midnight.
  const bucket = startOfLocalDay(dayStart);
  const day = new Date(bucket);

  const date = `${MONTHS[day.getMonth()]} ${day.getDate()}`;
  if (bucket === todayStart) {
    return `TODAY · ${date}`;
  }
  if (bucket === yesterdayStart) {
    return `YESTERDAY · ${date}`;
  }
  // 2–7 days ago: weekday name + calendar date (Daybook `.grp .d`).
  const ageDays = Math.floor((todayStart - bucket) / 86_400_000);
  if (ageDays >= 2 && ageDays <= 7) {
    return `${WEEKDAYS[day.getDay()]} · ${date}`;
  }
  // Older than a week: still produce a real date label if used as a section.
  return date;
}

/** Titlebar "DAY · DATE" chrome, e.g. "WEDNESDAY · AUG 12". */
export function titlebarDayDate(now: number = Date.now()): string {
  const d = new Date(now);
  return `${WEEKDAYS[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ── Normalization ────────────────────────────────────────────────────────────

export interface DmContactInput {
  personUid: string;
  email?: string | null;
  displayName?: string | null;
  companyUid?: string | null;
  /** Presigned avatar URL when hq-pro included it on the contacts roster. */
  avatarUrl?: string | null;
  lastMessageAt?: string | null;
  lastActivityAt?: string | null;
  lastDmAt?: string | null;
  /**
   * Server-supplied timestamp of the last message a person typed in this DM.
   * Present only when the server knows it; used only when the
   * `desktop.human-only-conversations` flag is on.
   */
  lastHumanMessageAt?: string | null;
  /**
   * `false` when the server knows the pair holds no human message; never
   * `true`. Absent with no `lastHumanMessageAt` means unknown.
   */
  hasHumanMessage?: boolean | null;
  /** Local-only activity dot — used when server pair unread is absent. */
  activityDot?: boolean;
  /**
   * Server pair unread (hq-pro US-010 `pairUnreads`). Absent/undefined/null →
   * legacy dot-only behavior. `0` = read (no badge/dot from this source);
   * `> 0` = numeric badge.
   */
  unreadCount?: number | null;
  /**
   * Audience of the last message: "human" | "agent" | "both". Absent on
   * older servers. US-006 reads this to decide whether to show or suppress
   * the preview in the DM rail (default: hide agent-only previews).
   */
  lastMessageAudience?: string | null;
}

/** The two wire fields that describe a conversation's last human message. */
export interface HumanRecencyFields {
  lastHumanMessageAt?: string | null;
  hasHumanMessage?: boolean | null;
}

/**
 * Resolve the human-recency fields when a new payload arrives for a
 * conversation the client already holds.
 *
 *  - incoming carries a time: known. A previous "none" is dropped.
 *  - incoming says `hasHumanMessage: false`: known none. A previous time is
 *    dropped, because the server is the only source of this value.
 *  - incoming carries neither: unknown on this payload, so whatever was known
 *    before is kept. An omitted field is never read as "none".
 *
 * Returns only the keys that apply, so the result can be spread over an
 * object that holds neither key.
 */
export function resolveHumanRecency(
  prev: HumanRecencyFields | null | undefined,
  incoming: HumanRecencyFields | null | undefined,
): { lastHumanMessageAt?: string; hasHumanMessage?: false } {
  const incomingAt = (incoming?.lastHumanMessageAt ?? "").trim();
  if (incomingAt) return { lastHumanMessageAt: incomingAt };
  if (incoming?.hasHumanMessage === false) return { hasHumanMessage: false };
  const prevAt = (prev?.lastHumanMessageAt ?? "").trim();
  if (prevAt) return { lastHumanMessageAt: prevAt };
  if (prev?.hasHumanMessage === false) return { hasHumanMessage: false };
  return {};
}

/** Copy of `value` without the two human-recency keys. */
function withoutHumanRecency<T extends HumanRecencyFields>(
  value: T,
): Omit<T, "lastHumanMessageAt" | "hasHumanMessage"> {
  const copy: HumanRecencyFields = { ...value };
  delete copy.lastHumanMessageAt;
  delete copy.hasHumanMessage;
  return copy as Omit<T, "lastHumanMessageAt" | "hasHumanMessage">;
}

/** One DM pair's human-recency fields, as read from GET /v1/notify/dm-threads. */
export interface DmHumanRecencyInput extends HumanRecencyFields {
  personUid: string;
}

/**
 * Apply DM human-recency fields from the DM thread listing onto the contacts
 * roster. Entries that carry neither field change nothing, so an older
 * server (or an inbox-derived activity entry) cannot erase a known value.
 * Returns the same array when nothing changed.
 */
export function applyDmHumanRecency(
  contacts: readonly DmContactInput[],
  entries: readonly DmHumanRecencyInput[],
): DmContactInput[] {
  const byUid = new Map<string, DmHumanRecencyInput>();
  for (const entry of entries) {
    const uid = (entry.personUid ?? "").trim();
    if (!uid) continue;
    const carriesTime = Boolean((entry.lastHumanMessageAt ?? "").trim());
    if (!carriesTime && entry.hasHumanMessage !== false) continue;
    byUid.set(uid, entry);
  }
  if (byUid.size === 0) return contacts as DmContactInput[];
  let changed = false;
  const next = contacts.map((contact) => {
    const entry = byUid.get(contact.personUid.trim());
    if (!entry) return contact;
    const resolved = resolveHumanRecency(contact, entry);
    const prevAt = (contact.lastHumanMessageAt ?? "").trim();
    if (
      (resolved.lastHumanMessageAt ?? "") === prevAt &&
      (resolved.hasHumanMessage === false) ===
        (!prevAt && contact.hasHumanMessage === false)
    ) {
      return contact;
    }
    changed = true;
    return { ...withoutHumanRecency(contact), ...resolved };
  });
  return changed ? next : (contacts as DmContactInput[]);
}

export interface InboxEventInput {
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  createdAt?: string | null;
  /** Message body, when the source carries one. */
  body?: string | null;
  details?: string | null;
  prompt?: string | null;
}

export interface PairUnreadInput {
  withPersonUid?: string | null;
  unreadCount?: number | null;
}

/**
 * Stamp 1:1 DM activity onto the contacts roster. Channel-directory rows do
 * not include pair DMs — those live on GET /v1/notify/inbox. Without this
 * merge, Jacob messaging today never becomes a sidebar row.
 */
export function mergeContactsWithInbox(
  contacts: readonly DmContactInput[],
  inboxEvents: readonly InboxEventInput[],
  pairUnreads: readonly PairUnreadInput[] = [],
): DmContactInput[] {
  const latest = new Map<string, InboxEventInput>();
  for (const event of inboxEvents) {
    const uid = (event.fromPersonUid ?? "").trim();
    if (!uid) continue;
    const prev = latest.get(uid);
    if (!prev || String(event.createdAt ?? "") > String(prev.createdAt ?? "")) {
      latest.set(uid, event);
    }
  }
  const unread = new Map<string, number>();
  for (const row of pairUnreads) {
    const uid = (row.withPersonUid ?? "").trim();
    if (!uid) continue;
    if (
      typeof row.unreadCount === "number" &&
      Number.isFinite(row.unreadCount)
    ) {
      unread.set(uid, Math.max(0, Math.floor(row.unreadCount)));
    }
  }
  const seen = new Set<string>();
  const out: DmContactInput[] = [];
  for (const contact of contacts) {
    const uid = contact.personUid.trim();
    if (!uid) continue;
    seen.add(uid);
    const event = latest.get(uid);
    // Take the NEWER of the inbox stamp and what the contact already carries.
    // The inbox only knows INBOUND DMs, so a pair you messaged yourself more
    // recently must not be dragged back to the counterpart's older reply.
    const at = newestIso(
      event?.createdAt,
      contact.lastMessageAt,
      contact.lastActivityAt,
    );
    out.push({
      ...contact,
      displayName:
        contact.displayName || event?.fromDisplayName || contact.displayName,
      email: contact.email || event?.fromEmail || contact.email,
      lastMessageAt: at ?? contact.lastMessageAt,
      lastActivityAt: at ?? contact.lastActivityAt,
      ...(unread.has(uid) ? { unreadCount: unread.get(uid) } : {}),
    });
  }
  for (const [uid, event] of latest) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const at = event.createdAt ?? null;
    out.push({
      personUid: uid,
      displayName: event.fromDisplayName ?? null,
      email: event.fromEmail ?? null,
      lastMessageAt: at,
      lastActivityAt: at,
      ...(unread.has(uid) ? { unreadCount: unread.get(uid) } : {}),
    });
  }
  // pairUnreads can outlive the inbox event window — still a conversation.
  for (const [uid, count] of unread) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      personUid: uid,
      unreadCount: count,
    });
  }
  return out;
}

export interface CachedDmThreadStamp {
  personUid: string;
  lastMessageAt?: string | null;
  displayName?: string | null;
  unreadCount?: number | null;
}

/**
 * Stamp last-message activity from cache/dms/{personUid}.json onto the
 * roster. Inbox is a 50-event window; pair threads on disk are the full
 * conversation signal the sidebar needs.
 */
export function stampContactsFromDmThreads(
  contacts: readonly DmContactInput[],
  threads: readonly CachedDmThreadStamp[],
): DmContactInput[] {
  const byUid = new Map<string, DmContactInput>();
  for (const contact of contacts) {
    const uid = contact.personUid.trim();
    if (!uid) continue;
    byUid.set(uid, { ...contact, personUid: uid });
  }
  for (const thread of threads) {
    const uid = thread.personUid.trim();
    if (!uid) continue;
    const prev = byUid.get(uid);
    const last =
      newerIso(thread.lastMessageAt, prev?.lastMessageAt) ??
      prev?.lastActivityAt ??
      null;
    const unread =
      typeof thread.unreadCount === "number" &&
      Number.isFinite(thread.unreadCount)
        ? Math.max(0, Math.floor(thread.unreadCount))
        : prev?.unreadCount;
    byUid.set(uid, {
      personUid: uid,
      email: prev?.email ?? null,
      displayName: prev?.displayName || thread.displayName || prev?.displayName,
      lastMessageAt: last ?? prev?.lastMessageAt ?? null,
      lastActivityAt: last ?? prev?.lastActivityAt ?? null,
      ...(typeof unread === "number" ? { unreadCount: unread } : {}),
      // The cached thread stamp says nothing about who typed. Keep what the
      // roster already knew.
      ...resolveHumanRecency(prev, null),
    });
  }
  return [...byUid.values()];
}

/**
 * Roster refreshes must not wipe timestamps. A contact file is often a
 * directory row with no lastMessageAt; after mark-read that would drop
 * the conversation from the rail.
 */
export function mergeContactActivity(
  previous: readonly DmContactInput[],
  incoming: readonly DmContactInput[],
): DmContactInput[] {
  const prevByUid = new Map(
    previous.map((contact) => [contact.personUid.trim(), contact]),
  );
  const seen = new Set<string>();
  const out: DmContactInput[] = [];
  for (const contact of incoming) {
    const uid = contact.personUid.trim();
    if (!uid) continue;
    seen.add(uid);
    const prev = prevByUid.get(uid);
    const last =
      newerIso(contact.lastMessageAt, prev?.lastMessageAt) ??
      newerIso(contact.lastActivityAt, prev?.lastActivityAt) ??
      newerIso(contact.lastDmAt, prev?.lastDmAt);
    out.push({
      ...withoutHumanRecency({ ...prev, ...contact }),
      personUid: uid,
      displayName: contact.displayName || prev?.displayName,
      email: contact.email || prev?.email,
      lastMessageAt:
        last ?? contact.lastMessageAt ?? prev?.lastMessageAt ?? null,
      lastActivityAt:
        last ?? contact.lastActivityAt ?? prev?.lastActivityAt ?? null,
      // A roster refresh that omits the human fields keeps the known state;
      // one that carries a field replaces the pair as a unit.
      ...resolveHumanRecency(prev, contact),
    });
  }
  for (const [uid, prev] of prevByUid) {
    if (seen.has(uid) || !contactHasConversation(prev)) continue;
    out.push(prev);
  }
  return out;
}

/** Newest of several ISO stamps (blank/absent ignored). */
function newestIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const value of values) best = newerIso(best, value);
  return best;
}

function newerIso(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const left = (a ?? "").trim();
  const right = (b ?? "").trim();
  if (!left) return right || null;
  if (!right) return left;
  return left >= right ? left : right;
}

export interface NormalizeOptions {
  pinnedIds?: ReadonlySet<string> | readonly string[];
  /**
   * companyUid → homeChannelId, from the roster (`Workspace.homeChannelId`).
   * Used to resolve `isCompanyHome` by channel id — see
   * `isCompanyHomeChannel()` in channels.ts. Absent/empty is safe — rows
   * simply carry whatever `channel.isCompanyHome` the server sent (or none).
   */
  homeChannelIdByUid?: ReadonlyMap<string, string> | Record<string, string>;
  /** Company uid → display name for company-home channel rows. */
  companyDisplayNamesByUid?: ReadonlyMap<string, string> | Record<string, string>;
  /** Local DM activity dots (personUid set). Absent-safe. */
  dmDots?: ReadonlySet<string> | readonly string[];
  /** Recently opened pair threads — stay conversations after mark-read. */
  recentDms?: ReadonlySet<string> | readonly string[];
  now?: number;
  /** Local project id → title so provisioned "Project slug hash" rows read as names. */
  projectTitles?: ReadonlyArray<{
    id: string;
    title?: string | null;
    name?: string | null;
  }>;
}

function toIdSet(
  value: ReadonlySet<string> | readonly string[] | undefined,
): Set<string> {
  if (!value) return new Set();
  return value instanceof Set ? new Set(value) : new Set(value);
}

/** Channel / group DM → ConversationRow. */
export function normalizeChannel(
  channel: Channel,
  options: NormalizeOptions = {},
): ConversationRow {
  const pinnedIds = toIdSet(options.pinnedIds);
  const id = `ch:${channel.channelId}`;
  const isGroup = channel.scope === "group";
  const activity = Math.max(
    parseActivityMs(channel.lastActivityAt),
    parseActivityMs(channel.lastMessageAt),
    parseActivityMs(channel.createdAt),
    typeof channel.arrivedAt === "number" ? channel.arrivedAt : 0,
  );
  const messageActivity = Math.max(
    parseActivityMs(channel.lastActivityAt),
    parseActivityMs(channel.lastMessageAt),
  );
  const humanMessageActivity = parseActivityMs(channel.lastHumanMessageAt);
  const knownNoHumanMessage =
    humanMessageActivity <= 0 && channel.hasHumanMessage === false;
  const createdForOrder = knownNoHumanMessage
    ? Math.max(
        parseActivityMs(channel.directoryCreatedAt),
        parseActivityMs(channel.createdAt),
      )
    : 0;
  const unread = Math.max(0, channel.unread ?? 0);
  const homeChannelId = channel.companyUid
    ? options.homeChannelIdByUid instanceof Map
      ? options.homeChannelIdByUid.get(channel.companyUid)
      : (options.homeChannelIdByUid as Record<string, string> | undefined)?.[
          channel.companyUid
        ]
    : undefined;
  const isCompanyHome =
    channel.scope === "company" ? isCompanyHomeChannel(channel, homeChannelId) : false;
  const companyDisplayName = channel.companyUid
    ? options.companyDisplayNamesByUid instanceof Map
      ? options.companyDisplayNamesByUid.get(channel.companyUid)
      : (options.companyDisplayNamesByUid as Record<string, string> | undefined)?.[
          channel.companyUid
        ]
    : undefined;

  return {
    id,
    kind: isGroup ? "group" : "channel",
    ...(isGroup ? {} : { channelScope: channel.scope }),
    ...(isGroup ? {} : { isCompanyHome }),
    title:
      (isCompanyHome ? companyDisplayName?.trim() : "") ||
      channelDisplayName(channel, {
        projectTitles: options.projectTitles,
      }),
    companyUid:
      isGroup || channel.scope === "personal"
        ? null
        : channel.companyUid?.trim() || null,
    // Channels get a numeric badge when unread > 0; group DMs use a dot only
    // (no reliable per-pair unread story yet for people, but channels ship unread).
    unreadCount: !isGroup && unread > 0 ? unread : undefined,
    unreadDot: isGroup ? unread > 0 : false,
    lastActivityAt: activity,
    messageActivityAt: messageActivity,
    ...(humanMessageActivity > 0
      ? { lastHumanMessageAt: humanMessageActivity }
      : {}),
    ...(knownNoHumanMessage ? { hasHumanMessage: false as const } : {}),
    ...(createdForOrder > 0 ? { createdAt: createdForOrder } : {}),
    pinned: pinnedIds.has(id),
    memberCount: channel.memberCount,
    members: channel.members,
    channelId: channel.channelId,
    projectId: channel.projectId ?? null,
    // Only a company-owned row can show a company icon.
    ...(!isGroup && channel.scope !== "personal" && channel.iconUrl
      ? { iconUrl: channel.iconUrl }
      : {}),
    ...(channel.membership != null ? { membership: channel.membership } : {}),
    ...(channel.notifyLevel != null ? { notifyLevel: channel.notifyLevel } : {}),
    ...(channel.createdBy ? { createdBy: channel.createdBy } : {}),
  };
}

/**
 * DM contact → ConversationRow.
 *
 * Unread is absent-safe across server generations:
 * - `unreadCount` number > 0 → numeric badge (no server-driven dot)
 * - `unreadCount` === 0 → read from server; no badge/dot from this source
 *   (local `dmDots` / `activityDot` may still light a dot)
 * - field absent/undefined/null → legacy dot-only behavior exactly as before
 *   US-011 (activityDot + local dmDots only)
 */
export function normalizeDm(
  contact: DmContactInput,
  options: NormalizeOptions = {},
): ConversationRow {
  const pinnedIds = toIdSet(options.pinnedIds);
  const dmDots = toIdSet(options.dmDots);
  const id = `dm:${contact.personUid}`;
  const title =
    contact.displayName?.trim() || contact.email?.trim() || contact.personUid;
  const activity = Math.max(
    parseActivityMs(contact.lastMessageAt),
    parseActivityMs(contact.lastActivityAt),
    parseActivityMs(contact.lastDmAt),
  );
  const humanMessageActivity = parseActivityMs(contact.lastHumanMessageAt);
  const localDot =
    contact.activityDot === true || dmDots.has(contact.personUid);
  const serverUnread = contact.unreadCount;
  const hasServerUnread =
    typeof serverUnread === "number" && Number.isFinite(serverUnread);
  const unreadCount =
    hasServerUnread && (serverUnread as number) > 0
      ? Math.floor(serverUnread as number)
      : undefined;
  // Numeric badge replaces the server-driven dot; local dots still apply when
  // the server says zero (or when the field is absent and only local dots exist).
  const unreadDot = hasServerUnread
    ? (serverUnread as number) > 0
      ? false
      : localDot
    : localDot;

  return {
    id,
    kind: "dm",
    title,
    companyUid: contact.companyUid?.trim() || null,
    ...(unreadCount != null ? { unreadCount } : {}),
    unreadDot,
    lastActivityAt: activity,
    ...(humanMessageActivity > 0
      ? { lastHumanMessageAt: humanMessageActivity }
      : contact.hasHumanMessage === false
        ? { hasHumanMessage: false as const }
        : {}),
    pinned: pinnedIds.has(id),
    personUid: contact.personUid,
    email: contact.email ?? null,
  };
}

/** Merge server pair-unread rollups onto DM contacts (absent-safe). */
export function applyPairUnreads(
  contacts: DmContactInput[],
  pairUnreads: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
): DmContactInput[] {
  const map =
    pairUnreads instanceof Map
      ? pairUnreads
      : new Map(Object.entries(pairUnreads));
  if (map.size === 0) return contacts;
  return contacts.map((c) => {
    if (!map.has(c.personUid)) return c;
    return { ...c, unreadCount: map.get(c.personUid) ?? 0 };
  });
}

/** Add `delta` (default 1) to one pair's numeric unread. */
export function incrementPairUnread(
  pairUnreads: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  personUid: string,
  delta: number = 1,
): Map<string, number> {
  const next =
    pairUnreads instanceof Map
      ? new Map(pairUnreads)
      : new Map(Object.entries(pairUnreads));
  const uid = personUid.trim();
  if (!uid) return next;
  next.set(uid, Math.max(0, (next.get(uid) ?? 0) + delta));
  return next;
}

/** Optimistically zero one pair's numeric unread (DM row opened). */
export function clearPairUnread(
  pairUnreads: ReadonlyMap<string, number> | Readonly<Record<string, number>>,
  personUid: string,
): Map<string, number> {
  const next =
    pairUnreads instanceof Map
      ? new Map(pairUnreads)
      : new Map(Object.entries(pairUnreads));
  next.set(personUid, 0);
  return next;
}

/**
 * True when a contact represents an actual DM conversation (any activity
 * timestamp, a server unread, or a local activity dot) rather than a bare
 * directory entry. The people directory (including raw `agt_*` ids the server
 * returns as contacts) must NOT render as sidebar conversation rows — contacts
 * without a conversation belong only in the new-message typeahead (G3).
 */
export function contactHasConversation(
  contact: DmContactInput,
  options: NormalizeOptions = {},
): boolean {
  const activity = Math.max(
    parseActivityMs(contact.lastMessageAt),
    parseActivityMs(contact.lastActivityAt),
    parseActivityMs(contact.lastDmAt),
  );
  if (activity > 0) return true;
  if (typeof contact.unreadCount === "number" && contact.unreadCount > 0)
    return true;
  if (contact.activityDot === true) return true;
  if (toIdSet(options.dmDots).has(contact.personUid)) return true;
  return toIdSet(options.recentDms).has(contact.personUid);
}

export function normalizeConversations(
  channels: Channel[],
  contacts: DmContactInput[],
  options: NormalizeOptions & {
    /**
     * Include contacts with no conversation signal (typeahead / palette /
     * people search). Default false: the sidebar shows conversations only.
     */
    includeContactsWithoutConversation?: boolean;
  } = {},
): ConversationRow[] {
  const dmContacts = options.includeContactsWithoutConversation
    ? contacts
    : contacts.filter((c) => contactHasConversation(c, options));
  const rows: ConversationRow[] = [
    ...channels.map((c) => normalizeChannel(c, options)),
    ...dmContacts.map((c) => normalizeDm(c, options)),
  ];
  const seen = new Set<string>();
  const deduped: ConversationRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    deduped.push(row);
  }
  return collapseDuplicateGroupRows(collapseDuplicateDmRows(deduped));
}

/**
 * US-017: collapse indistinguishable DM peers. Distinct emails stay as
 * separate rows. Same title with no email (Scouty ×3) keeps the most
 * recently active row and the higher unread.
 */
export function collapseDuplicateDmRows(
  rows: ConversationRow[],
): ConversationRow[] {
  const rest: ConversationRow[] = [];
  const byKey = new Map<string, ConversationRow>();
  for (const row of rows) {
    if (row.kind !== "dm") {
      rest.push(row);
      continue;
    }
    const email = (row.email ?? "").trim().toLowerCase();
    const key = email || `name:${row.title.trim().toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const prevScore =
      prev.lastActivityAt + (prev.unreadCount ?? (prev.unreadDot ? 1 : 0));
    const nextScore =
      row.lastActivityAt + (row.unreadCount ?? (row.unreadDot ? 1 : 0));
    byKey.set(key, nextScore >= prevScore ? row : prev);
  }
  return [...rest, ...byKey.values()];
}

/**
 * Duplicate 1:1 group channels for the same counterpart originate SERVER-SIDE
 * (distinct channelIds whose roster resolves to the same people). This is a
 * client-side mitigation: group rows with an identical participant roster
 * collapse to one, keeping the most recently active (same scoring as
 * collapseDuplicateDmRows). Rows without member info are left alone — never
 * collapse rows you cannot key. Channel and DM rows are not moved.
 */
export function collapseDuplicateGroupRows(
  rows: ConversationRow[],
): ConversationRow[] {
  const bestByKey = new Map<string, ConversationRow>();
  for (const row of rows) {
    if (row.kind !== "group") continue;
    const key = groupRosterKey(row);
    if (!key) continue;
    const prev = bestByKey.get(key);
    if (!prev) {
      bestByKey.set(key, row);
      continue;
    }
    const prevScore =
      prev.lastActivityAt + (prev.unreadCount ?? (prev.unreadDot ? 1 : 0));
    const nextScore =
      row.lastActivityAt + (row.unreadCount ?? (row.unreadDot ? 1 : 0));
    bestByKey.set(key, nextScore >= prevScore ? row : prev);
  }
  const seen = new Set<string>();
  const out: ConversationRow[] = [];
  for (const row of rows) {
    if (row.kind !== "group") {
      out.push(row);
      continue;
    }
    const key = groupRosterKey(row);
    if (!key) {
      out.push(row);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(bestByKey.get(key) ?? row);
  }
  return out;
}

/** Sorted, deduped member personUids; fall back to lowercased displayNames. */
function groupRosterKey(row: ConversationRow): string | null {
  const members = row.members ?? [];
  if (members.length === 0) return null;
  const uids = [
    ...new Set(
      members.map((member) => (member.personUid ?? "").trim()).filter(Boolean),
    ),
  ].sort();
  if (uids.length > 0) return `uid:${uids.join("\0")}`;
  const names = [
    ...new Set(
      members
        .map((member) => (member.displayName ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  if (names.length === 0) return null;
  return `name:${names.join("\0")}`;
}

// ── Channel fabric directory rows (US-009) ───────────────────────────────────

/**
 * Map one server-shaped directory row onto the sidebar's `Channel` shape.
 *
 * The directory row is AUTHORITATIVE for identity fields — name, scope,
 * companyUid, unread, memberCount, mentionFlag. Activity is the NEWER of the
 * directory stamp and any locally observed `lastActivityAt` / `lastMessageAt`
 * (own sends and loaded timelines). A stale snapshot must not rewind a
 * channel out of TODAY. A null directory stamp with no local activity still
 * means empty — no arrivedAt / createdAt fabrication. Enrichment the
 * directory does not carry (group-DM roster, membership, post policy, project
 * binding) is preserved from the previously hydrated channel when available.
 */
export function directoryRowToChannel(
  row: ChannelDirectoryRow,
  prev?: Channel,
): Channel {
  const activity = newestIso(
    row.lastActivityAt,
    prev?.lastActivityAt,
    prev?.lastMessageAt,
  );
  return {
    channelId: row.channelId,
    name: row.name || prev?.name || "",
    scope: row.scope,
    // `undefined` means the server hasn't rolled the field out on this row;
    // keep whatever we already knew rather than silently reverting to the
    // name-match fallback on every subsequent (unrelated) directory update.
    isCompanyHome: row.isCompanyHome ?? prev?.isCompanyHome ?? false,
    companyUid: row.companyUid ?? null,
    companyName: row.companyName ?? prev?.companyName ?? null,
    // `undefined` on the row means "not served / not sent" — keep whatever we
    // already had. An explicit `null` means "this company has no icon" and DOES
    // clear it, so removing a website removes the icon without a reload.
    ...(row.iconUrl !== undefined
      ? { iconUrl: row.iconUrl }
      : prev?.iconUrl != null
        ? { iconUrl: prev.iconUrl }
        : {}),
    ...(prev?.postPolicy != null ? { postPolicy: prev.postPolicy } : {}),
    ...(prev?.visibility != null ? { visibility: prev.visibility } : {}),
    ...(prev?.membership != null ? { membership: prev.membership } : {}),
    ...(prev?.members != null || row.members
      ? { members: row.members ?? prev?.members }
      : {}),
    projectId: row.projectId ?? prev?.projectId ?? null,
    lastActivityAt: activity,
    // Three states: a time, a known "none", or neither. A row that omits both
    // fields keeps what the previous payload established. See
    // `resolveHumanRecency`.
    ...resolveHumanRecency(prev, row),
    ...(row.createdAt || prev?.directoryCreatedAt
      ? { directoryCreatedAt: row.createdAt || prev?.directoryCreatedAt }
      : {}),
    ...(activity
      ? { lastMessageAt: newestIso(prev?.lastMessageAt, activity) }
      : {}),
    unread: mergeDirectoryUnread({
      incomingUnread: row.unreadCount,
      incomingActivityAt: row.lastActivityAt,
      prevUnread: prev?.unread,
      prevActivityAt: prev?.lastActivityAt ?? prev?.lastMessageAt,
    }),
    memberCount: row.memberCount,
    mentionFlag: row.mentionFlag === true,
    subtitle: row.subtitle ?? null,
    ...(row.createdBy || prev?.createdBy
      ? { createdBy: row.createdBy ?? prev?.createdBy }
      : {}),
    // A row without a level keeps the one we already knew (an optimistic
    // change, or a richer earlier payload); an explicit null clears it.
    ...(row.notifyLevel !== undefined
      ? { notifyLevel: row.notifyLevel }
      : prev?.notifyLevel !== undefined
        ? { notifyLevel: prev.notifyLevel }
        : {}),
  };
}

/** Set one channel's notification level (optimistic change or rollback). */
export function applyChannelNotifyLevel(
  channels: ReadonlyArray<Channel>,
  channelId: string,
  level: NotifyLevel | null,
): Channel[] {
  return channels.map((channel) =>
    channel.channelId === channelId ? { ...channel, notifyLevel: level } : channel,
  );
}

/**
 * Apply a reconciled directory row list onto the sidebar channel state:
 * the row set is the full authoritative list (the reconciler already folded
 * snapshot/changed/removed), each row enriched from its previous channel.
 *
 * Company-home channels are the one exception to "the incoming set is
 * authoritative": an intermittent server hiccup (see
 * `~/.hq/logs/hq-sync.log` `MESSAGES_CHANNELS_BODY_READ_FAIL` /
 * `DM_NOTIFY_CHAN_POLL_ERROR`) can make a SNAPSHOT refresh come back missing
 * a channel the client already resolved, even though nothing actually
 * changed server-side. For a normal channel that just means a stale row
 * briefly lingers — for a company's home channel it means the sidebar's
 * "Companies" section silently reverts to "still connecting" and clicking it
 * stops working again after having worked a moment ago (reported by Jacob:
 * companies flip to "no home channel" after a refresh). A previously-known
 * home channel is carried forward when it's simply absent from `rows` —
 * never dropped for a transient/incomplete fetch. It disappears for real
 * once the caller learns (via a row that DOES arrive) that it stopped being
 * the home channel, or via `removeChannel` on an explicit deletion — both
 * unaffected by this carry-forward.
 */
export function applyDirectoryRows(
  rows: ReadonlyArray<ChannelDirectoryRow>,
  prevChannels: ReadonlyArray<Channel>,
): Channel[] {
  const prevById = new Map(prevChannels.map((c) => [c.channelId, c]));
  const seenIds = new Set(rows.map((row) => row.channelId));
  const next = rows.map((row) =>
    directoryRowToChannel(row, prevById.get(row.channelId)),
  );
  const strandedHomeChannels = prevChannels.filter(
    (c) => c.isCompanyHome === true && !seenIds.has(c.channelId),
  );
  return strandedHomeChannels.length > 0
    ? [...next, ...strandedHomeChannels]
    : next;
}

/**
 * Apply a reconciled directory snapshot. An empty incoming list must not wipe
 * a host-seeded overlay (web `ssr=false` + cleared localStorage otherwise
 * races the first fetch and paints "No conversations").
 */
export function applyDirectoryFeed(
  incoming: ReadonlyArray<ChannelDirectoryRow>,
  prevChannels: ReadonlyArray<Channel>,
  seed?: ReadonlyArray<ChannelDirectoryRow> | null,
): Channel[] {
  if (incoming.length === 0 && seed && seed.length > 0) {
    return applyDirectoryRows(seed, prevChannels);
  }
  return applyDirectoryRows(incoming, prevChannels);
}

// ── Filters + sort ───────────────────────────────────────────────────────────

export function filterByCompanyScope(
  rows: ConversationRow[],
  scope: CompanyScope,
): ConversationRow[] {
  if (scope === "all") return rows.slice();
  if (scope === "personal") {
    // Personal channels (companyUid null + kind channel) and DMs without a
    // company attachment. Group DMs stay visible under personal as direct chat.
    return rows.filter((row) => {
      if (row.kind === "group") return true;
      if (row.kind === "dm") return !row.companyUid;
      return !row.companyUid;
    });
  }
  // Specific company: that company's channels plus DMs/groups (people are
  // not company-scoped — hide them and the company rail looks empty).
  return rows.filter((row) => {
    if (row.kind === "dm" || row.kind === "group") return true;
    return row.companyUid === scope;
  });
}

/**
 * A channel row that belongs under the project filters: project/company
 * scoped only — personal-scope channels never qualify. Rows from older caches
 * may lack `channelScope`; fall back to the companyUid invariant
 * (normalizeChannel nulls companyUid for personal-scope channels).
 */
function isProjectFilterChannel(row: ConversationRow): boolean {
  if (row.kind !== "channel") return false;
  if (row.channelScope != null) {
    return row.channelScope === "project" || row.channelScope === "company";
  }
  return row.companyUid != null;
}

/**
 * True when a channel row counts as the current user's own under "My
 * projects": any membership except an explicit `'none'`. Absent membership
 * counts as mine (the channels endpoint only lists the caller's channels).
 */
export function isMineChannelRow(
  row: Pick<ConversationRow, "membership" | "browseOnly">,
): boolean {
  if (row.browseOnly) return false;
  return (row.membership ?? "joined") !== "none";
}

export function filterByShow(
  rows: ConversationRow[],
  show: ShowFilter,
): ConversationRow[] {
  // US-021: browse-only rows (other members' project channels, owner view)
  // surface ONLY under 'company-projects'; every other view hides them.
  if (show === "company-projects") {
    return rows.filter(isProjectFilterChannel);
  }
  const memberRows = rows.filter((row) => !row.browseOnly);
  if (show === "all") return memberRows;
  if (show === "mine") {
    return memberRows.filter(
      (row) => row.kind !== "channel" || isMineChannelRow(row),
    );
  }
  if (show === "projects") {
    return memberRows.filter(isProjectFilterChannel);
  }
  // DMs: 1:1 + group DMs
  return memberRows.filter((row) => row.kind === "dm" || row.kind === "group");
}

/** Filter to a single DM counterpart (personUid). */
export function filterByPerson(
  rows: ConversationRow[],
  personUid: string | null | undefined,
): ConversationRow[] {
  if (!personUid) return rows.slice();
  return rows.filter(
    (row) =>
      (row.kind === "dm" && row.personUid === personUid) ||
      (row.kind === "group" &&
        (row.members ?? []).some((m) => m.personUid === personUid)),
  );
}

/** What the row carries about the conversation's last human message. */
export type RowHumanRecencyState = "known" | "none" | "unknown";

/**
 * The three human-recency states of a row. Match `humanRecencyState` in
 * `@hq/platform`.
 *
 *  - `known`: the server sent a last-human-message time.
 *  - `none`: the server said the conversation holds no human message.
 *  - `unknown`: the server sent neither field (an older server, a 1:1 DM the
 *    server does not report on, or a channel it has not examined).
 */
export function rowHumanRecencyState(row: ConversationRow): RowHumanRecencyState {
  if ((row.lastHumanMessageAt ?? 0) > 0) return "known";
  if (row.hasHumanMessage === false) return "none";
  return "unknown";
}

/**
 * Recency key of a row. It is the one value the sidebar places a row by: the
 * row order (`compareRowRecency`), the day sections (`groupByDay`), the
 * history view (`searchHistory`, `historyDayGroups`), and the boot pick
 * (`pickAutoOpenConversation`) all read it, so a row cannot sit in a section
 * that disagrees with where the order puts it. Match `humanRecencyKey` in
 * `@hq/platform`.
 *
 * In `humanOnly` mode:
 *  - `known`: the last-human-message time.
 *  - `none` with a creation time: the creation time, on the same timeline
 *    as human times. A conversation created today sits where "today" puts
 *    it, and one created a month ago that only bots post in sits a month
 *    back. Bot and session activity never moves such a row.
 *  - `none` without a creation time: `lastActivityAt`, exactly like an
 *    unknown row. Today that is every 1:1 DM, because the DM thread listing
 *    carries no creation time. A new teammate's DM on the day they join, or
 *    an agent's first DM, must be visible under Today and not buried in a
 *    collapsed older section. This is an interim rule (owner decision,
 *    2026-10-02) until the server supplies a creation time for DM rows.
 *    With no activity time either, the key is 0 and `compareRowRecency`
 *    places the row below every other.
 *  - `unknown`: `lastActivityAt`, so a row the server has not reported on
 *    keeps its place instead of sinking to the bottom in title order.
 *
 * With the flag off the key is `lastActivityAt`.
 */
export function rowRecencyKey(
  row: ConversationRow,
  humanOnly: boolean,
): number {
  if (humanOnly) {
    const state = rowHumanRecencyState(row);
    if (state === "known") return row.lastHumanMessageAt ?? 0;
    if (state === "none" && (row.createdAt ?? 0) > 0) {
      return row.createdAt ?? 0;
    }
    // `none` without a creation time is placed like `unknown`, below.
  }
  return row.lastActivityAt;
}

/**
 * True for a row that has no place on the timeline in `humanOnly` mode: it
 * is known to hold no human message and carries neither a creation time nor
 * an activity time. Such rows form the bottom tier, ordered by title. A
 * known-none row that has an activity time is not in it (see
 * `rowRecencyKey`). Match `isUndatedNoHumanRow` in `@hq/platform`.
 */
export function isUndatedNoHumanRow(
  row: ConversationRow,
  humanOnly: boolean,
): boolean {
  return (
    humanOnly &&
    rowHumanRecencyState(row) === "none" &&
    !((row.createdAt ?? 0) > 0) &&
    !(row.lastActivityAt > 0)
  );
}

/**
 * Order two rows by recency: negative when `a` sorts first, 0 on a tie (the
 * caller then applies its own tie-break). Rows are ordered by
 * `rowRecencyKey`, newest first. In `humanOnly` mode a row known to hold no
 * human message that has neither a creation time nor an activity time sorts
 * below every other row; such rows tie, which leaves them in title order
 * under the caller's tie-break. Match `compareHumanRecency` in
 * `@hq/platform`.
 */
export function compareRowRecency(
  a: ConversationRow,
  b: ConversationRow,
  humanOnly: boolean,
): number {
  const aBottom = isUndatedNoHumanRow(a, humanOnly);
  const bBottom = isUndatedNoHumanRow(b, humanOnly);
  if (aBottom !== bBottom) return aBottom ? 1 : -1;
  if (aBottom && bBottom) return 0;
  return rowRecencyKey(b, humanOnly) - rowRecencyKey(a, humanOnly);
}

export function sortConversations(
  rows: ConversationRow[],
  mode: SortMode,
  humanOnly = false,
): ConversationRow[] {
  const copy = rows.slice();
  if (mode === "type") {
    const order: Record<ConversationKind, number> = {
      channel: 0,
      group: 1,
      dm: 2,
    };
    copy.sort((a, b) => {
      const kindDiff = order[a.kind] - order[b.kind];
      if (kindDiff !== 0) return kindDiff;
      const recency = compareRowRecency(a, b, humanOnly);
      if (recency !== 0) return recency;
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
    return copy;
  }
  // Recent
  copy.sort((a, b) => {
    const recency = compareRowRecency(a, b, humanOnly);
    if (recency !== 0) return recency;
    // Unread breaks a tie, as it always has, including for a known-none row
    // placed by its activity. The one exception is the bottom tier (known to
    // hold no human message, with no creation time and no activity time):
    // those rows are ordered by title, since nothing else places them.
    const bottomTier = isUndatedNoHumanRow(a, humanOnly);
    if (!bottomTier) {
      const aUnread = a.unreadCount ?? (a.unreadDot ? 1 : 0);
      const bUnread = b.unreadCount ?? (b.unreadDot ? 1 : 0);
      if (bUnread !== aUnread) return bUnread - aUnread;
    }
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  return copy;
}

/**
 * True when a new-message wake could change a channel's human recency, so the
 * sidebar should read the directory again.
 *
 * A row in the unknown state is ordered by `lastActivityAt`, which the wake
 * itself stamps, so it needs no server read. A row in the known or none state
 * is ordered by a value only the server computes: the wake names a sender and
 * a time, but it cannot say whether a person typed the message (a work
 * session posts under the person's uid). An agent's post never counts as a
 * typed message, and a wake no newer than the known time changes nothing.
 */
export function wakeMayChangeHumanRecency(
  channel: Pick<Channel, "lastHumanMessageAt" | "hasHumanMessage"> | undefined,
  wake: { createdAt?: string | null; fromPersonUid?: string | null },
): boolean {
  if (!channel) return false;
  const knownAt = (channel.lastHumanMessageAt ?? "").trim();
  const knownNone = !knownAt && channel.hasHumanMessage === false;
  if (!knownAt && !knownNone) return false;
  if (isAgentUid((wake.fromPersonUid ?? "").trim())) return false;
  const at = (wake.createdAt ?? "").trim();
  if (!at) return false;
  if (knownNone) return true;
  const atMs = Date.parse(at);
  const knownMs = Date.parse(knownAt);
  return Number.isFinite(atMs) && Number.isFinite(knownMs)
    ? atMs > knownMs
    : at > knownAt;
}

export function applySidebarFilters(
  rows: ConversationRow[],
  options: {
    scope?: CompanyScope;
    show?: ShowFilter;
    sort?: SortMode;
    personUid?: string | null;
    /**
     * When true, sort by the last human message, in three states: a known
     * time, a known "none" (by creation time, on the same timeline, or by
     * `lastActivityAt` when the row has no creation time), or unknown
     * (falls back to `lastActivityAt`). See `compareRowRecency`.
     */
    humanOnly?: boolean;
  } = {},
): ConversationRow[] {
  let next = rows;
  next = filterByCompanyScope(next, options.scope ?? "all");
  next = filterByShow(next, options.show ?? DEFAULT_SHOW_FILTER);
  next = filterByPerson(next, options.personUid ?? null);
  return sortConversations(
    next,
    options.sort ?? "recent",
    options.humanOnly === true,
  );
}

// ── Day grouping ─────────────────────────────────────────────────────────────

/**
 * Split filtered rows into pinned + day sections + LAST WEEK (>7d).
 * `now` is injectable for deterministic tests.
 *
 * A row is bucketed by `rowRecencyKey`, the same key the order uses. With
 * `humanOnly` on that is the last human message for a row that has one, the
 * creation time for a row known to hold none that has one (never a day its
 * bot or session activity fell on), and `lastActivityAt` for a known-none
 * row without a creation time and for a row the server has not reported on.
 * A row whose key is 0 lands in `lastWeek`. With it off the key is
 * `lastActivityAt`.
 * Rows keep their input order inside a bucket, so rows sorted with the same
 * `humanOnly` come out in that order, section after section.
 */
export function groupByDay(
  rows: ConversationRow[],
  now: number = Date.now(),
  options: { humanOnly?: boolean } = {},
): GroupedConversations {
  const humanOnly = options.humanOnly === true;
  const pinned = rows.filter((r) => r.pinned);
  const unpinned = rows.filter((r) => !r.pinned);

  const todayStart = startOfLocalDay(now);
  // Anything with activity strictly before (todayStart - 6 days) is older than
  // 7 calendar days of day-buckets (today + 6 prior days). Collapse those.
  const lastWeekCutoff = todayStart - 6 * 86_400_000;

  const lastWeek: ConversationRow[] = [];
  const byDay = new Map<number, ConversationRow[]>();

  for (const row of unpinned) {
    const key = rowRecencyKey(row, humanOnly);
    const activity = key > 0 ? key : 0;
    if (activity < lastWeekCutoff) {
      lastWeek.push(row);
      continue;
    }
    const dayStart = activity > 0 ? startOfLocalDay(activity) : todayStart;
    // Guard: if somehow still older, dump to last week.
    if (dayStart < lastWeekCutoff) {
      lastWeek.push(row);
      continue;
    }
    const bucket = byDay.get(dayStart) ?? [];
    bucket.push(row);
    byDay.set(dayStart, bucket);
  }

  // Sections newest-first.
  const dayStarts = [...byDay.keys()].sort((a, b) => b - a);
  const sections: DaySection[] = dayStarts.map((dayStart) => ({
    key: `day:${dayStart}`,
    label: daySectionLabel(dayStart, now),
    rows: byDay.get(dayStart) ?? [],
  }));

  return {
    pinned,
    sections,
    lastWeek,
    all: rows.slice(),
  };
}

const TYPE_SECTION_ORDER: ReadonlyArray<{
  kind: ConversationKind;
  key: string;
  label: string;
}> = [
  { kind: "channel", key: "type:channel", label: "PROJECT CHANNELS" },
  { kind: "group", key: "type:group", label: "GROUPS" },
  { kind: "dm", key: "type:dm", label: "DIRECT MESSAGES" },
];

/**
 * Group the rail by conversation kind. Used when Sort = Type so day buckets
 * cannot hide the type order.
 */
export function groupByType(rows: ConversationRow[]): GroupedConversations {
  const pinned = rows.filter((r) => r.pinned);
  const unpinned = rows.filter((r) => !r.pinned);
  const sections: DaySection[] = [];
  for (const section of TYPE_SECTION_ORDER) {
    const bucket = unpinned.filter((row) => row.kind === section.kind);
    if (bucket.length === 0) continue;
    sections.push({
      key: section.key,
      label: section.label,
      rows: bucket,
    });
  }
  return {
    pinned,
    sections,
    lastWeek: [],
    all: rows.slice(),
  };
}

/**
 * Default siderail budget. The directory can be hundreds of project rows
 * (empty channels stamped "this week"); the rail only needs the live set.
 * "Show all history…" keeps the full filtered list.
 */
export const RAIL_CONVERSATION_LIMIT = 28;
/** Cap on unpinned project/company channels after DMs / unread / pins. */
export const RAIL_CHANNEL_LIMIT = 16;

function rowMustStayOnRail(
  row: ConversationRow,
  selectedId: string | null,
  recentPersonUids: Set<string>,
): boolean {
  if (row.pinned) return true;
  if (selectedId && row.id === selectedId) return true;
  if ((row.unreadCount ?? 0) > 0 || row.unreadDot) return true;
  if (row.kind === "dm" || row.kind === "group") return true;
  if (row.personUid && recentPersonUids.has(row.personUid)) return true;
  return false;
}

/**
 * A team channel owned by a company (`channelScope === "company"`).
 * Home's inbox omits these; they live in that company's pane under Activity.
 * Project channels and DMs are not company-scoped.
 */
export function isCompanyScopedChannel(row: ConversationRow): boolean {
  return row.kind === "channel" && (row.channelScope ?? "").trim() === "company";
}

/** Home inbox rows: everything except company-scoped channels. */
export function omitCompanyScopedChannels(
  rows: readonly ConversationRow[],
): ConversationRow[] {
  return rows.filter((row) => !isCompanyScopedChannel(row));
}

/** Company-scoped channels for one company, newest activity first. */
export function companyScopedChannels(
  rows: readonly ConversationRow[],
  companyUid: string,
): ConversationRow[] {
  const uid = companyUid.trim();
  if (!uid) return [];
  return sortConversations(
    rows.filter(
      (row) => isCompanyScopedChannel(row) && (row.companyUid ?? "").trim() === uid,
    ),
    "recent",
  );
}

/** Unread on a company's channels, for the rail tile badge. */
export function companyChannelUnread(
  rows: readonly ConversationRow[],
  companyUid: string,
): number {
  let total = 0;
  for (const row of rows) {
    if (!isCompanyScopedChannel(row)) continue;
    if ((row.companyUid ?? "").trim() !== companyUid.trim()) continue;
    total += row.unreadCount ?? (row.unreadDot ? 1 : 0);
  }
  return total;
}

/** One company's channels in the All scope, under a quiet company header. */
export interface CompanyChannelGroup {
  companyUid: string;
  label: string;
  iconUrl: string | null;
  rows: ConversationRow[];
  /** Newest activity across the group's channels (0 when unknown). */
  latestAt: number;
  /** Summed unread across the group's channels (dots count as 1). */
  unread: number;
}

/**
 * All scope: every company's channels, grouped by company. Groups are ordered
 * by their newest channel activity; channels inside a group keep the same
 * newest-first order the single-company Activity section uses. Rows keep
 * their own unread / muted flags untouched.
 */
export function groupCompanyChannelsByCompany(
  rows: readonly ConversationRow[],
  companies: readonly ScopeCompany[] = [],
): CompanyChannelGroup[] {
  const byUid = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    if (!isCompanyScopedChannel(row)) continue;
    const uid = (row.companyUid ?? "").trim();
    if (!uid) continue;
    const list = byUid.get(uid);
    if (list) list.push(row);
    else byUid.set(uid, [row]);
  }
  const groups: CompanyChannelGroup[] = [];
  for (const [uid, list] of byUid) {
    const company = companies.find((c) => c.companyUid === uid);
    const sorted = companyScopedChannels(list, uid);
    groups.push({
      companyUid: uid,
      label: company?.label?.trim() || uid,
      iconUrl: company?.iconUrl ?? null,
      rows: sorted,
      latestAt: sorted.reduce((max, r) => Math.max(max, r.lastActivityAt || 0), 0),
      unread: sorted.reduce(
        (sum, r) => sum + (r.unreadCount ?? (r.unreadDot ? 1 : 0)),
        0,
      ),
    });
  }
  return groups.sort(
    (a, b) => b.latestAt - a.latestAt || a.label.localeCompare(b.label),
  );
}

export const COLLAPSED_COMPANY_CHANNELS_STORAGE_KEY =
  "hq.chat.collapsed-company-channels";

/** Company uids whose channel group the user collapsed in the All scope. */
export function loadCollapsedCompanyChannels(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(
      storage.getItem(COLLAPSED_COMPANY_CHANNELS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
      : [];
  } catch (err) {
    console.warn("[sidebar] collapsed company channels unreadable", err);
    return [];
  }
}

/** Toggle one company's collapse state and persist it; returns the new list. */
export function toggleCollapsedCompanyChannels(
  collapsed: readonly string[],
  companyUid: string,
  storage: Pick<Storage, "setItem"> | null | undefined,
): string[] {
  const uid = companyUid.trim();
  if (!uid) return [...collapsed];
  const next = collapsed.includes(uid)
    ? collapsed.filter((v) => v !== uid)
    : [...collapsed, uid];
  try {
    storage?.setItem(COLLAPSED_COMPANY_CHANNELS_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[sidebar] collapsed company channels not saved", err);
  }
  return next;
}

export function isProjectConversationRow(row: ConversationRow): boolean {
  if (row.kind !== "channel") return false;
  if (row.channelScope != null) {
    return row.channelScope === "project" || row.channelScope === "company";
  }
  return row.companyUid != null;
}

/**
 * Keep every DM/group, pins, unread, and the open thread. Project channels
 * get a small reserved slice so empty "this week" projects cannot crowd
 * a read DM off the rail after you click away.
 */
export function takeRailConversations(
  rows: readonly ConversationRow[],
  options: {
    limit?: number;
    channelLimit?: number;
    selectedId?: string | null;
    recentPersonUids?: ReadonlySet<string> | readonly string[];
  } = {},
): ConversationRow[] {
  const channelLimit = options.channelLimit ?? RAIL_CHANNEL_LIMIT;
  const selectedId = options.selectedId ?? null;
  const recentPersonUids = toIdSet(options.recentPersonUids);
  if (rows.length <= (options.limit ?? RAIL_CONVERSATION_LIMIT)) {
    return rows.slice();
  }

  const keep = new Set<string>();
  for (const row of rows) {
    if (rowMustStayOnRail(row, selectedId, recentPersonUids)) keep.add(row.id);
  }
  let projects = 0;
  for (const row of rows) {
    if (projects >= channelLimit) break;
    if (!isProjectConversationRow(row)) continue;
    if (!keep.has(row.id)) {
      keep.add(row.id);
      projects += 1;
    }
  }
  return rows.filter((row) => keep.has(row.id));
}

/**
 * First conversation to open when the shell has no selection. Skips
 * browse-only owner rows. Prefer the most recent row by the order the rail
 * uses (`compareRowRecency`): the newest `lastActivityAt`, or with
 * `humanOnly` on the row the human order puts first. Otherwise the shell
 * could open a conversation whose only recent activity is a bot's, which
 * the rail lists in its last section.
 */
export function pickAutoOpenConversation(
  rows: readonly ConversationRow[],
  selectedId?: string | null,
  humanOnly = false,
): ConversationRow | null {
  if ((selectedId ?? "").trim()) return null;
  let best: ConversationRow | null = null;
  for (const row of rows) {
    if (row.browseOnly) continue;
    if (!best || compareRowRecency(row, best, humanOnly) < 0) best = row;
  }
  return best;
}

/**
 * Boot pick while #welcome still owns first landing (setup not yet run on
 * this machine): the synthetic #welcome row wins over every live channel so
 * a new person sees Run Setup, not a company channel with nothing connected.
 * Returns null when there is no #welcome row (or a selection already exists)
 * so callers fall through to the normal auto-open.
 */
export function pickWelcomeFirstConversation(
  rows: readonly ConversationRow[],
  selectedId?: string | null,
): ConversationRow | null {
  if ((selectedId ?? "").trim()) return null;
  for (const row of rows) {
    if (row.browseOnly) continue;
    if (isSetupChannel(row.channelId)) return row;
  }
  return null;
}

/**
 * Conversation to open once first-paint fetches have settled (or timed out).
 * Real rows still win. If the rail is only the synthetic #setup channel,
 * open that rather than leaving the conversation pane on an infinite skeleton.
 */
export function pickSettledBootConversation(
  rows: readonly ConversationRow[],
  selectedId?: string | null,
  humanOnly = false,
): ConversationRow | null {
  if ((selectedId ?? "").trim()) return null;
  const live = pickAutoOpenConversation(
    rows.filter((row) => !isSetupChannel(row.channelId)),
    selectedId,
    humanOnly,
  );
  if (live) return live;
  for (const row of rows) {
    if (row.browseOnly) continue;
    if (isSetupChannel(row.channelId)) return row;
  }
  return null;
}

/** Cap the authoritative directory dump before it hits sidebar state. */
export const DIRECTORY_SEED_LIMIT = 24;

export function takeDirectorySeed<
  T extends {
    channelId: string;
    unreadCount?: number | null;
    lastActivityAt?: string | number | null;
  },
>(rows: readonly T[], limit: number = DIRECTORY_SEED_LIMIT): T[] {
  // Dedupe by channel id FIRST, at every size. This seed becomes the persisted
  // rail, the ⌘K index and the first-paint channel list, all of which render
  // keyed by channel id — one repeated id is an `each_key_duplicate` crash that
  // takes the whole shell down, not a harmless double row. Order is preserved,
  // so a list that already fits still comes back in server order.
  const deduped: T[] = [];
  const byId = new Set<string>();
  for (const row of rows) {
    if (byId.has(row.channelId)) continue;
    byId.add(row.channelId);
    deduped.push(row);
  }
  if (deduped.length <= limit) return deduped;
  const unread = deduped.filter((row) => (row.unreadCount ?? 0) > 0);
  const rest = deduped
    .filter((row) => (row.unreadCount ?? 0) <= 0)
    .slice()
    .sort((a, b) => {
      const left = String(b.lastActivityAt ?? "");
      const right = String(a.lastActivityAt ?? "");
      return left.localeCompare(right);
    });
  const extra: T[] = [];
  for (const row of rest) {
    if (unread.length + extra.length >= limit) break;
    extra.push(row);
  }
  return [...unread, ...extra];
}

// ── Scope pill cycling ───────────────────────────────────────────────────────

export type ScopeOption =
  | { id: "all"; label: string }
  | { id: "personal"; label: string }
  | { id: string; label: string; companyUid: string };

export function buildScopeOptions(companies: ScopeCompany[]): ScopeOption[] {
  const opts: ScopeOption[] = [{ id: "all", label: "All" }];
  for (const c of companies) {
    opts.push({ id: c.companyUid, label: c.label, companyUid: c.companyUid });
  }
  opts.push({ id: "personal", label: "Personal" });
  return opts;
}

/** Cycle All → companies… → Personal → All. */
export function nextScope(
  current: CompanyScope,
  companies: ScopeCompany[],
): CompanyScope {
  const opts = buildScopeOptions(companies);
  const idx = opts.findIndex((o) => o.id === current);
  const next = opts[(idx < 0 ? 0 : idx + 1) % opts.length];
  return next.id;
}

/**
 * Rail rows in DISPLAY order — pinned, then each day section, then the
 * collapsed "Last week" rows only when that group is expanded. Feeds the
 * next/previous conversation shortcuts so ⌘⇧] walks the list the user sees.
 */
export function flattenGrouped(
  grouped: GroupedConversations,
  includeLastWeek: boolean,
): ConversationRow[] {
  const out: ConversationRow[] = [...grouped.pinned];
  for (const section of grouped.sections) out.push(...section.rows);
  if (includeLastWeek) out.push(...grouped.lastWeek);
  return out;
}

/**
 * Step through `rows` from `currentId` by `delta`, wrapping at both ends.
 * Falls back to the first row when the current one is not listed; null when
 * there is nothing to step to.
 */
export function stepConversation(
  rows: ConversationRow[],
  currentId: string | null | undefined,
  delta: 1 | -1,
): ConversationRow | null {
  if (rows.length === 0) return null;
  const index = currentId ? rows.findIndex((row) => row.id === currentId) : -1;
  if (index < 0) return rows[0];
  const next = (index + delta + rows.length) % rows.length;
  return rows[next];
}

export function scopePillLabel(
  scope: CompanyScope,
  companies: ScopeCompany[],
): string {
  if (scope === "all") return "All";
  if (scope === "personal") return "Personal";
  return companies.find((c) => c.companyUid === scope)?.label ?? "Company";
}

// ── Pin persistence ──────────────────────────────────────────────────────────

export function loadPins(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function savePins(
  ids: readonly string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(PINS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Quota / private mode — best-effort.
  }
}

// ── "Companies" sidebar section — user-chosen company selection ────────────

/**
 * The user's chosen company selection for the sidebar's "Companies" section.
 * `null` = no explicit choice yet (defaults to showing every company the
 * caller belongs to, INCLUDING ones joined after the pref was last read — see
 * `resolveCompanySectionSelection`). A non-null array is the exact set of
 * companyUids to show, persisted verbatim (may legitimately be empty).
 */
export function loadPinnedCompanies(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PINNED_COMPANIES_STORAGE_KEY);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return null;
  }
}

export function savePinnedCompanies(
  companyUids: readonly string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(PINNED_COMPANIES_STORAGE_KEY, JSON.stringify([...companyUids]));
  } catch {
    // Quota / private mode — best-effort.
  }
}

/**
 * Finds THE home-channel row for a company by companyUid, among the caller's
 * own (non-browse-only) channel rows. Used by both the sidebar's "Companies"
 * section and the shell's slug-based channel lookup (`companyChannelRowForSlug`)
 * so there is exactly one place that decides "which row is the company home."
 */
export function findCompanyHomeRow(
  rows: ReadonlyArray<ConversationRow>,
  companyUid: string,
): ConversationRow | null {
  const needle = companyUid.trim();
  if (!needle) return null;
  return (
    rows.find((row) => {
      if (row.kind !== "channel" || row.browseOnly) return false;
      if ((row.channelScope ?? "") !== "company") return false;
      if (!row.isCompanyHome) return false;
      return (row.companyUid ?? "").trim() === needle;
    }) ?? null
  );
}

/** One row in the sidebar's "Companies" section. */
export interface CompanySectionRow {
  companyUid: string;
  label: string;
  /** Company slug, for log lines (`[companies] open company=<slug> …`). */
  slug?: string | null;
  iconUrl?: string | null;
  /** The company's home-channel id, straight from the roster
   * (`Workspace.homeChannelId`) — clients open it directly by id, no
   * client-side row lookup. `null` when the company has no home channel yet
   * (new/legacy company still provisioning); the section shows it disabled
   * with a reason rather than hiding it, so a newly-joined company never
   * silently disappears. */
  homeChannelId: string | null;
}

/** Default number of companies the "Companies" section shows when the user
 * has not pinned any (ranked by `rankCompaniesByActivity`). */
export const DEFAULT_COMPANY_SECTION_LIMIT = 3;

/**
 * Activity score for one company, used to rank the "Companies" section's
 * default top-N view. Rule (documented per the brief):
 *
 *  1. Prefer the company's home channel's `messageActivityAt` — the latest
 *     DURABLE MESSAGE timestamp (not `lastActivityAt`, which falls back to
 *     `createdAt` for ordering and would rank a never-talked-in company
 *     above a genuinely active one that merely lacks a resolved home row).
 *  2. When the home channel isn't resolved yet, or has never carried a
 *     message, fall back to the busiest OTHER `channelScope === "company"`
 *     row for that company (team channels) — a company can be very active in
 *     its team channels while its home channel sits quiet.
 *  3. A company with no activity anywhere scores 0 and sorts last.
 */
export function companyActivityScore(
  companyUid: string,
  rows: ReadonlyArray<ConversationRow>,
): number {
  const home = findCompanyHomeRow(rows, companyUid);
  const homeActivity = home?.messageActivityAt ?? 0;
  if (homeActivity > 0) return homeActivity;
  let best = 0;
  for (const row of rows) {
    if (row.kind !== "channel") continue;
    if ((row.channelScope ?? "") !== "company") continue;
    if ((row.companyUid ?? "").trim() !== companyUid.trim()) continue;
    best = Math.max(best, row.messageActivityAt ?? 0);
  }
  return best;
}

/**
 * Companies ordered by `companyActivityScore`, most active first. Ties break
 * by label (then uid) so ordering is deterministic for tests and stable
 * across renders when scores are equal (e.g. two companies with zero
 * activity).
 */
export function rankCompaniesByActivity<
  T extends { companyUid: string; label: string },
>(companies: ReadonlyArray<T>, rows: ReadonlyArray<ConversationRow>): T[] {
  return companies.slice().sort((a, b) => {
    const diff =
      companyActivityScore(b.companyUid, rows) -
      companyActivityScore(a.companyUid, rows);
    if (diff !== 0) return diff;
    return (
      a.label.localeCompare(b.label) || a.companyUid.localeCompare(b.companyUid)
    );
  });
}

/**
 * Reinterpret the OLD `pinnedCompanySelection` persisted shape — "which
 * companies to SHOW" (`null` = show every company; an array = the exact
 * visible set, including a deliberate empty array for "hide all") — as the
 * NEW true-pin semantics ("which companies the user explicitly pinned;
 * absent/empty = no pins yet, so the section falls back to the top-N by
 * activity").
 *
 * Migration decision (documented per the brief): a stored array that names
 * EVERY company the caller belongs to, or an empty array, reads as the OLD
 * default state ("nothing customized" / "hid everything") rather than
 * deliberate intent to pin a narrow set — both are discarded (become `null`,
 * "no pins", so the new top-N default takes over instead of pinning
 * everything or showing nothing). A stored array that is a PROPER, NON-EMPTY
 * subset of the caller's companies reads as genuine intent to narrow the
 * list down to specific companies, and is carried forward as the initial
 * pinned set — the closest available approximation of "the companies this
 * user cares about," which is exactly what a pin now means.
 */
export function migratePinnedCompanySelection(
  oldSelection: readonly string[] | null,
  allCompanyUids: readonly string[],
): string[] | null {
  if (oldSelection === null) return null;
  const selected = new Set(
    oldSelection.map((uid) => uid.trim()).filter(Boolean),
  );
  if (selected.size === 0) return null;
  const all = new Set(
    allCompanyUids.map((uid) => uid.trim()).filter(Boolean),
  );
  if (all.size > 0) {
    let coversAll = true;
    for (const uid of all) {
      if (!selected.has(uid)) {
        coversAll = false;
        break;
      }
    }
    if (coversAll) return null;
  }
  return [...selected];
}

/**
 * Resolves the sidebar's "Companies" section: one row per shown company, each
 * carrying its home-channel row (if any) so the caller can open it.
 *
 * Selection semantics (step 8, revised per the follow-up brief):
 * - `pinnedCompanyUids` non-empty → show ONLY the pinned companies, in
 *   `companies` order — pins always win, never mixed with the top-N default.
 * - `pinnedCompanyUids` absent/empty (`null` or `[]`, no true pins yet) →
 *   show the `limit` most active companies, ranked by
 *   `rankCompaniesByActivity`.
 * - A company with no `homeChannelId` yet is still included (with
 *   `homeChannelId: null`) so the section can render it disabled with a
 *   reason, per the brief's "hide or show disabled" choice — this
 *   implementation shows disabled so the user isn't left wondering where a
 *   company went.
 */
export function resolveCompanySectionRows(
  companies: ReadonlyArray<{
    companyUid: string;
    label: string;
    slug?: string | null;
    iconUrl?: string | null;
    homeChannelId?: string | null;
  }>,
  rows: ReadonlyArray<ConversationRow>,
  pinnedCompanyUids: readonly string[] | null,
  limit: number = DEFAULT_COMPANY_SECTION_LIMIT,
): CompanySectionRow[] {
  const cleaned = companies.filter((c) => c.companyUid.trim());
  const pinned = new Set(
    (pinnedCompanyUids ?? []).map((uid) => uid.trim()).filter(Boolean),
  );
  const chosen =
    pinned.size > 0
      ? cleaned.filter((c) => pinned.has(c.companyUid.trim()))
      : rankCompaniesByActivity(cleaned, rows).slice(0, Math.max(0, limit));
  return chosen.map((c) => ({
    companyUid: c.companyUid,
    label: c.label,
    slug: c.slug ?? null,
    iconUrl: c.iconUrl ?? null,
    homeChannelId: (c.homeChannelId ?? "").trim() || null,
  }));
}

/**
 * Load the persisted Show filter. New/unset users default to `'mine'`
 * (member projects, chats, and DMs). An existing persisted choice is kept.
 */
export function loadShowFilter(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ShowFilter {
  if (!storage) return DEFAULT_SHOW_FILTER;
  try {
    const raw = storage.getItem(SHOW_FILTER_STORAGE_KEY);
    return isShowFilter(raw) ? raw : DEFAULT_SHOW_FILTER;
  } catch {
    return DEFAULT_SHOW_FILTER;
  }
}

export function saveShowFilter(
  filter: ShowFilter,
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(SHOW_FILTER_STORAGE_KEY, filter);
  } catch {
    // Quota / private mode — best-effort.
  }
}

export function loadSetupPinDismissed(
  storage: Pick<Storage, "getItem"> | null | undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SETUP_PIN_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSetupPinDismissed(
  storage: Pick<Storage, "setItem" | "removeItem"> | null | undefined,
  dismissed: boolean,
): void {
  if (!storage) return;
  try {
    if (dismissed) storage.setItem(SETUP_PIN_DISMISSED_STORAGE_KEY, "1");
    else storage.removeItem(SETUP_PIN_DISMISSED_STORAGE_KEY);
  } catch {
    // Quota / private mode — best-effort.
  }
}

export function togglePin(
  pins: readonly string[],
  conversationId: string,
): string[] {
  const set = new Set(pins);
  if (set.has(conversationId)) set.delete(conversationId);
  else set.add(conversationId);
  return [...set];
}

// ── DM dots (local-only) ─────────────────────────────────────────────────────

export function loadDmDots(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(DM_DOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function saveDmDots(
  personUids: readonly string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(DM_DOTS_STORAGE_KEY, JSON.stringify([...personUids]));
  } catch {
    // best-effort
  }
}

export function clearDmDot(
  personUids: readonly string[],
  personUid: string,
): string[] {
  return personUids.filter((id) => id !== personUid);
}

export function loadRecentDms(
  storage: Pick<Storage, "getItem"> | null | undefined,
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_DMS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

export function saveRecentDms(
  personUids: readonly string[],
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(RECENT_DMS_STORAGE_KEY, JSON.stringify([...personUids]));
  } catch {
    // best-effort
  }
}

export function rememberRecentDm(
  personUids: readonly string[],
  personUid: string,
): string[] {
  const uid = personUid.trim();
  if (!uid) return [...personUids];
  return [uid, ...personUids.filter((id) => id !== uid)].slice(0, 40);
}

// ── Conversation cache (cache-first sidebar paint) ───────────────────────────

export interface ConversationCachePayload {
  channels: Channel[];
  contacts: DmContactInput[];
  cachedAt: number;
}

export function loadConversationCache(
  storage: Pick<Storage, "getItem"> | null | undefined,
): ConversationCachePayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONVERSATION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConversationCachePayload;
    if (
      !parsed ||
      !Array.isArray(parsed.channels) ||
      !Array.isArray(parsed.contacts)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveConversationCache(
  payload: ConversationCachePayload,
  storage: Pick<Storage, "setItem"> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(CONVERSATION_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // best-effort
  }
}

// ── People list (filter popover) ─────────────────────────────────────────────

export interface PersonOption {
  personUid: string;
  label: string;
}

/** Distinct DM counterparts from the row set. */
export function distinctDmPeople(rows: ConversationRow[]): PersonOption[] {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "dm" || !row.personUid) continue;
    if (!map.has(row.personUid)) map.set(row.personUid, row.title);
  }
  return [...map.entries()]
    .map(([personUid, label]) => ({ personUid, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── Typeahead (new-message modal) ────────────────────────────────────────────

export function filterTypeahead(
  rows: ConversationRow[],
  query: string,
  limit: number = 20,
): ConversationRow[] {
  const q = query.trim().toLowerCase();
  const base = q
    ? rows.filter((row) => {
        if (row.title.toLowerCase().includes(q)) return true;
        if (row.email?.toLowerCase().includes(q)) return true;
        if (row.members?.some((m) => m.displayName.toLowerCase().includes(q)))
          return true;
        return false;
      })
    : rows;
  return sortConversations(base, "recent").slice(0, limit);
}

/**
 * Client-side search over titles for the history view, newest first by the
 * order the rail uses (`compareRowRecency`). With `humanOnly` off that is
 * `lastActivityAt`, as before.
 */
export function searchHistory(
  rows: ConversationRow[],
  query: string,
  humanOnly = false,
): ConversationRow[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? rows.filter((row) => row.title.toLowerCase().includes(q))
    : rows.slice();
  return hits.sort((a, b) => compareRowRecency(a, b, humanOnly));
}

export interface HistoryDayGroup {
  label: string;
  rows: ConversationRow[];
}

/**
 * Day separators for the history view: Today / Yesterday / "Aug 21" /
 * "Aug 21, 2025" (other years) — rows without a known timestamp fall into a
 * trailing "Older" bucket. Input is assumed newest-first (searchHistory).
 */
export function historyDayGroups(
  rows: ConversationRow[],
  now: Date = new Date(),
  humanOnly = false,
): HistoryDayGroup[] {
  const labelFor = (at: number): string => {
    if (!at) return "Older";
    const d = new Date(at);
    const today = new Date(now);
    const yesterday = new Date(now);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    const opts: Intl.DateTimeFormatOptions =
      d.getFullYear() === today.getFullYear()
        ? { month: "short", day: "numeric" }
        : { month: "short", day: "numeric", year: "numeric" };
    return d.toLocaleDateString([], opts);
  };
  const groups: HistoryDayGroup[] = [];
  for (const row of rows) {
    // The same key `searchHistory` orders by, so a row's day label cannot
    // disagree with its position.
    const label = labelFor(rowRecencyKey(row, humanOnly));
    const last = groups.at(-1);
    if (last && last.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** Initials for avatar monograms (max 2). */
export function initialsFor(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (
      `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase() || "?"
    );
  }
  return title.trim().slice(0, 2).toUpperCase() || "?";
}

export type RowAvatarKind = "photo" | "generated" | "initials";

export interface RowAvatar {
  kind: RowAvatarKind;
  src?: string;
  initials?: string;
}

/**
 * Rail avatar for a conversation row: real photo when known, else a
 * deterministic generated avatar for agents, else initials.
 */
export function rowAvatar(
  row: Pick<ConversationRow, "kind" | "personUid" | "title">,
  avatarByUid?: Record<string, string> | null,
): RowAvatar {
  const uid = (row.personUid ?? "").trim();
  const photo = uid ? paintableAvatarSrc(avatarByUid?.[uid]) : null;
  if (photo) return { kind: "photo", src: photo };
  if (row.kind === "dm" && uid && isAgentUid(uid)) {
    const generated = agentAvatarFor(uid);
    if (generated) return { kind: "generated", src: generated };
  }
  return { kind: "initials", initials: initialsFor(row.title) };
}

// ── Command palette conversation ranking (US-013) ────────────────────────────

export type ConversationKindLabel = "Channel" | "DM" | "Group";

/** Human type tag for palette / search result rows. */
export function conversationKindLabel(
  kind: ConversationKind,
): ConversationKindLabel {
  if (kind === "channel") return "Channel";
  if (kind === "group") return "Group";
  return "DM";
}

/**
 * Match score for palette ranking. Higher is better.
 *  - 3: title starts with query
 *  - 2: title contains query
 *  - 1: email / member name contains query
 *  - 0: no match (caller usually filters these out when query is non-empty)
 */
export function conversationQueryScore(
  row: ConversationRow,
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1; // empty query: treat as weakly matched so recency can rank
  const title = row.title.toLowerCase();
  if (title.startsWith(q)) return 3;
  if (title.includes(q)) return 2;
  if (row.email?.toLowerCase().includes(q)) return 1;
  if (row.members?.some((m) => m.displayName.toLowerCase().includes(q)))
    return 1;
  return 0;
}

/**
 * Filter + rank conversations for the ⌘K palette (cross-company).
 * Rank: query match strength, then recency, then title. Caps at `limit`.
 */
export function rankPaletteConversations(
  rows: ConversationRow[],
  query: string,
  limit: number = 12,
): ConversationRow[] {
  const q = query.trim();
  const scored = rows
    .map((row) => ({ row, score: conversationQueryScore(row, q) }))
    .filter((entry) => (q ? entry.score > 0 : true));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.row.lastActivityAt !== a.row.lastActivityAt) {
      return b.row.lastActivityAt - a.row.lastActivityAt;
    }
    return (
      a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id)
    );
  });
  return scored.slice(0, limit).map((e) => e.row);
}

/** Company label lookup for palette rows (uid → display name). */
export function companyLabelFor(
  companyUid: string | null | undefined,
  companies: ScopeCompany[],
): string | null {
  if (!companyUid) return null;
  return companies.find((c) => c.companyUid === companyUid)?.label ?? null;
}

/** Inline rail chip: company name for channels/agents, email for people. */
export type RailScopeLabelKind = "company" | "email";

export interface RailScopeLabel {
  kind: RailScopeLabelKind;
  text: string;
}

const RAW_COMPANY_UID = /^[a-z]{2,5}_[A-Za-z0-9_-]+$/;

/**
 * Display name for a conversation's company. Prefers the memberships list;
 * falls back to a human-readable `companyUid` (fixture rows that stored the
 * name in that field). Opaque `cmp_…` / `co_…` identifiers stay hidden.
 */
export function resolveRailCompanyName(
  companyUid: string | null | undefined,
  companies: ScopeCompany[],
): string | null {
  const fromList = companyLabelFor(companyUid, companies)?.trim();
  if (fromList) return fromList;
  const raw = companyUid?.trim() ?? "";
  if (!raw || RAW_COMPANY_UID.test(raw)) return null;
  return raw;
}

function isAgentDmRow(row: ConversationRow): boolean {
  return row.kind === "dm" && !!row.personUid && isAgentUid(row.personUid);
}

function isHumanDmRow(row: ConversationRow): boolean {
  return row.kind === "dm" && !!row.personUid && !isAgentUid(row.personUid);
}

/** Lowercased titles that appear on more than one human DM (disambiguation). */
export function duplicateHumanDmTitles(
  rows: readonly ConversationRow[],
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!isHumanDmRow(row)) continue;
    const key = row.title.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [key, count] of counts) {
    if (count > 1) dupes.add(key);
  }
  return dupes;
}

/**
 * Secondary rail label. In "All companies", channels and agent DMs show the
 * company name and human DMs show email. In a single-company (or personal)
 * scope the company name is redundant, so it is omitted; human emails stay
 * only when two people share a display name.
 */
export function railRowScopeLabel(
  row: ConversationRow,
  options: {
    scope: CompanyScope;
    companies: ScopeCompany[];
    enabled: boolean;
    duplicateHumanTitles?: ReadonlySet<string>;
  },
): RailScopeLabel | null {
  if (!options.enabled) return null;
  const allCompanies = options.scope === "all";

  if (row.kind === "channel" || row.kind === "group" || isAgentDmRow(row)) {
    if (!allCompanies) return null;
    const name = resolveRailCompanyName(row.companyUid, options.companies);
    return name ? { kind: "company", text: name } : null;
  }

  if (isHumanDmRow(row)) {
    const email = row.email?.trim() ?? "";
    if (!email) return null;
    if (allCompanies) return { kind: "email", text: email };
    const titleKey = row.title.trim().toLowerCase();
    if (titleKey && options.duplicateHumanTitles?.has(titleKey)) {
      return { kind: "email", text: email };
    }
    return null;
  }

  return null;
}

// ── Message content search (all-history, US-013) ─────────────────────────────

/** Wire hit from `search_messages` / `GET /v1/notify/search`. */
export interface MessageSearchHit {
  messageId: string;
  scope: "dm" | "channel" | string;
  channelId?: string | null;
  counterpartyUid?: string | null;
  companyUid?: string | null;
  projectId?: string | null;
  snippet?: string | null;
  body?: string | null;
  createdAt: string;
}

export interface MessageSearchResult {
  results: MessageSearchHit[];
}

/**
 * Resolve the companyUid argument for `search_messages` from the sidebar scope.
 * Specific company → that uid; All / Personal → null (no company filter).
 */
export function searchCompanyUidFromScope(scope: CompanyScope): string | null {
  if (scope === "all" || scope === "personal") return null;
  const uid = scope.trim();
  return uid || null;
}

/** Scope label shown near the all-history search input. */
export function historySearchScopeLabel(
  scope: CompanyScope,
  companies: ScopeCompany[],
): string {
  if (scope === "all") return "All companies";
  if (scope === "personal") return "Personal";
  return companies.find((c) => c.companyUid === scope)?.label ?? "Company";
}

/** Prefer snippet, fall back to body. */
export function searchHitSnippet(hit: MessageSearchHit): string {
  const snippet = hit.snippet?.trim();
  if (snippet) return snippet;
  return hit.body?.trim() || "";
}

/**
 * Map a search hit onto a local ConversationRow when possible (title + kind).
 * Falls back to a synthetic row from hit metadata so the UI can still open.
 */
export function resolveSearchHitRow(
  hit: MessageSearchHit,
  rows: ConversationRow[],
): ConversationRow {
  if (hit.scope === "dm" && hit.counterpartyUid) {
    const existing = rows.find(
      (r) => r.kind === "dm" && r.personUid === hit.counterpartyUid,
    );
    if (existing) return existing;
    return {
      id: `dm:${hit.counterpartyUid}`,
      kind: "dm",
      title: hit.counterpartyUid,
      companyUid: hit.companyUid ?? null,
      unreadDot: false,
      lastActivityAt: parseActivityMs(hit.createdAt),
      pinned: false,
      personUid: hit.counterpartyUid,
    };
  }
  if (hit.channelId) {
    const existing = rows.find(
      (r) =>
        (r.kind === "channel" || r.kind === "group") &&
        r.channelId === hit.channelId,
    );
    if (existing) return existing;
    return {
      id: `ch:${hit.channelId}`,
      kind: "channel",
      title: hit.channelId,
      companyUid: hit.companyUid ?? null,
      unreadDot: false,
      lastActivityAt: parseActivityMs(hit.createdAt),
      pinned: false,
      channelId: hit.channelId,
    };
  }
  // Unknown shape — best-effort synthetic id so the list can still key rows.
  return {
    id: `search:${hit.messageId}`,
    kind: hit.scope === "dm" ? "dm" : "channel",
    title: searchHitSnippet(hit).slice(0, 48) || hit.messageId,
    companyUid: hit.companyUid ?? null,
    unreadDot: false,
    lastActivityAt: parseActivityMs(hit.createdAt),
    pinned: false,
    ...(hit.channelId ? { channelId: hit.channelId } : {}),
    ...(hit.counterpartyUid ? { personUid: hit.counterpartyUid } : {}),
  };
}

/** Compact relative/absolute timestamp for search result rows. */
export function formatSearchHitTime(
  createdAt: string,
  now: number = Date.now(),
): string {
  const ms = parseActivityMs(createdAt);
  if (!ms) return "";
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  const day = startOfLocalDay(ms);
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const time = `${hh}:${mm}`;
  if (day === todayStart) return time;
  if (day === yesterdayStart) return `Yesterday ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}
