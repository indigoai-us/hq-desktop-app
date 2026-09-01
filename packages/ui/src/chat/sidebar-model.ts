/**
 * Pure model for the chat-first unified conversation sidebar (US-003).
 *
 * No Svelte / DOM — unit-tested with real dates. Normalizes channels + DMs into
 * rows, groups by day (TODAY / YESTERDAY / weekday / LAST WEEK collapse),
 * filters by company scope + show kind, sorts, and persists pins.
 */

import {
  channelDisplayName,
  mergeDirectoryUnread,
  type Channel,
  type ChannelMembership,
  type ChannelParticipant,
} from "./channels";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import { isAgentUid } from "./agent-thinking";
import { agentAvatarFor } from "./messaging/agent-avatars";

// ── Row shape ────────────────────────────────────────────────────────────────

export type ConversationKind = "channel" | "dm" | "group";

export interface ConversationRow {
  /** Stable id: `ch:<channelId>` or `dm:<personUid>`. */
  id: string;
  kind: ConversationKind;
  title: string;
  /** Company scope when known; null for personal / pure DMs / group DMs. */
  companyUid: string | null;
  /** Numeric unread — channels, and DMs when server pairUnreads is present. */
  unreadCount?: number;
  /** Dot indicator for activity (DMs without numeric unread / optional channel activity). */
  unreadDot: boolean;
  /** Epoch-ms of most recent activity (0 when unknown). */
  lastActivityAt: number;
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
}

/**
 * Metadata that can arrive after a deep-link's synthetic conversation row.
 * Activity and local presentation state (`unreadCount`, `unreadDot`,
 * `lastActivityAt`, `pinned`) are deliberately excluded: they fluctuate and
 * must never make initial-row reconciliation replace a user's selection.
 */
const CONVERSATION_ROW_RICHNESS_FIELDS = [
  "companyUid",
  "projectId",
  "channelId",
  "channelScope",
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

// ── Timestamp helpers ────────────────────────────────────────────────────────

export function parseActivityMs(
  value: string | number | null | undefined,
): number {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function startOfLocalDay(ms: number): number {
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
  lastMessageAt?: string | null;
  lastActivityAt?: string | null;
  lastDmAt?: string | null;
  /** Local-only activity dot — used when server pair unread is absent. */
  activityDot?: boolean;
  /**
   * Server pair unread (hq-pro US-010 `pairUnreads`). Absent/undefined/null →
   * legacy dot-only behavior. `0` = read (no badge/dot from this source);
   * `> 0` = numeric badge.
   */
  unreadCount?: number | null;
}

export interface InboxEventInput {
  fromPersonUid?: string | null;
  fromEmail?: string | null;
  fromDisplayName?: string | null;
  createdAt?: string | null;
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
      ...prev,
      ...contact,
      personUid: uid,
      displayName: contact.displayName || prev?.displayName,
      email: contact.email || prev?.email,
      lastMessageAt:
        last ?? contact.lastMessageAt ?? prev?.lastMessageAt ?? null,
      lastActivityAt:
        last ?? contact.lastActivityAt ?? prev?.lastActivityAt ?? null,
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
  const unread = Math.max(0, channel.unread ?? 0);

  return {
    id,
    kind: isGroup ? "group" : "channel",
    ...(isGroup ? {} : { channelScope: channel.scope }),
    title: channelDisplayName(channel, {
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
    pinned: pinnedIds.has(id),
    memberCount: channel.memberCount,
    members: channel.members,
    channelId: channel.channelId,
    projectId: channel.projectId ?? null,
    ...(channel.membership != null ? { membership: channel.membership } : {}),
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
 * The directory row is AUTHORITATIVE for every directory field — name, scope,
 * companyUid, unread, memberCount, mentionFlag, and especially
 * `lastActivityAt`: a `null` there means the channel is EMPTY, so the mapped
 * channel carries no `lastMessageAt` / `createdAt` / `arrivedAt` fallback the
 * grouping could mistake for activity (an empty channel must NEVER bucket
 * under "today"). Enrichment the directory does not carry (group-DM roster,
 * membership, post policy, project binding) is preserved from the previously
 * hydrated channel when available.
 */
export function directoryRowToChannel(
  row: ChannelDirectoryRow,
  prev?: Channel,
): Channel {
  return {
    channelId: row.channelId,
    name: row.name || prev?.name || "",
    scope: row.scope,
    companyUid: row.companyUid ?? null,
    companyName: prev?.companyName ?? null,
    ...(prev?.postPolicy != null ? { postPolicy: prev.postPolicy } : {}),
    ...(prev?.visibility != null ? { visibility: prev.visibility } : {}),
    ...(prev?.membership != null ? { membership: prev.membership } : {}),
    ...(prev?.members != null || row.members
      ? { members: row.members ?? prev?.members }
      : {}),
    projectId: row.projectId ?? prev?.projectId ?? null,
    // Directory-authoritative activity. Null stays null — no arrivedAt /
    // createdAt / lastMessageAt fabrication.
    lastActivityAt: row.lastActivityAt,
    unread: mergeDirectoryUnread({
      incomingUnread: row.unreadCount,
      incomingActivityAt: row.lastActivityAt,
      prevUnread: prev?.unread,
      prevActivityAt: prev?.lastActivityAt ?? prev?.lastMessageAt,
    }),
    memberCount: row.memberCount,
    mentionFlag: row.mentionFlag === true,
    subtitle: row.subtitle ?? null,
  };
}

/**
 * Apply a reconciled directory row list onto the sidebar channel state:
 * the row set is the full authoritative list (the reconciler already folded
 * snapshot/changed/removed), each row enriched from its previous channel.
 */
export function applyDirectoryRows(
  rows: ReadonlyArray<ChannelDirectoryRow>,
  prevChannels: ReadonlyArray<Channel>,
): Channel[] {
  const prevById = new Map(prevChannels.map((c) => [c.channelId, c]));
  return rows.map((row) =>
    directoryRowToChannel(row, prevById.get(row.channelId)),
  );
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

export function sortConversations(
  rows: ConversationRow[],
  mode: SortMode,
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
      if (b.lastActivityAt !== a.lastActivityAt)
        return b.lastActivityAt - a.lastActivityAt;
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
    return copy;
  }
  // Recent
  copy.sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt)
      return b.lastActivityAt - a.lastActivityAt;
    const aUnread = a.unreadCount ?? (a.unreadDot ? 1 : 0);
    const bUnread = b.unreadCount ?? (b.unreadDot ? 1 : 0);
    if (bUnread !== aUnread) return bUnread - aUnread;
    return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  });
  return copy;
}

export function applySidebarFilters(
  rows: ConversationRow[],
  options: {
    scope?: CompanyScope;
    show?: ShowFilter;
    sort?: SortMode;
    personUid?: string | null;
  } = {},
): ConversationRow[] {
  let next = rows;
  next = filterByCompanyScope(next, options.scope ?? "all");
  next = filterByShow(next, options.show ?? DEFAULT_SHOW_FILTER);
  next = filterByPerson(next, options.personUid ?? null);
  return sortConversations(next, options.sort ?? "recent");
}

// ── Day grouping ─────────────────────────────────────────────────────────────

/**
 * Split filtered rows into pinned + day sections + LAST WEEK (>7d).
 * `now` is injectable for deterministic tests.
 */
export function groupByDay(
  rows: ConversationRow[],
  now: number = Date.now(),
): GroupedConversations {
  const pinned = rows.filter((r) => r.pinned);
  const unpinned = rows.filter((r) => !r.pinned);

  const todayStart = startOfLocalDay(now);
  // Anything with activity strictly before (todayStart - 6 days) is older than
  // 7 calendar days of day-buckets (today + 6 prior days). Collapse those.
  const lastWeekCutoff = todayStart - 6 * 86_400_000;

  const lastWeek: ConversationRow[] = [];
  const byDay = new Map<number, ConversationRow[]>();

  for (const row of unpinned) {
    const activity = row.lastActivityAt > 0 ? row.lastActivityAt : 0;
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
 * browse-only owner rows. Prefer the newest lastActivityAt.
 */
export function pickAutoOpenConversation(
  rows: readonly ConversationRow[],
  selectedId?: string | null,
): ConversationRow | null {
  if ((selectedId ?? "").trim()) return null;
  let best: ConversationRow | null = null;
  for (const row of rows) {
    if (row.browseOnly) continue;
    if (!best || row.lastActivityAt > best.lastActivityAt) best = row;
  }
  return best;
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
  if (rows.length <= limit) return rows.slice();
  const unread = rows.filter((row) => (row.unreadCount ?? 0) > 0);
  const rest = rows
    .filter((row) => (row.unreadCount ?? 0) <= 0)
    .slice()
    .sort((a, b) => {
      const left = String(b.lastActivityAt ?? "");
      const right = String(a.lastActivityAt ?? "");
      return left.localeCompare(right);
    });
  const seen = new Set(unread.map((row) => row.channelId));
  const extra: T[] = [];
  for (const row of rest) {
    if (unread.length + extra.length >= limit) break;
    if (seen.has(row.channelId)) continue;
    seen.add(row.channelId);
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
 * Resolve a scope hotkey:
 *  - Cmd+0 → all
 *  - Cmd+1..Cmd+5 → company at index 0..4
 *  - Cmd+P → personal
 * Returns null when the key does not match.
 */
export function scopeFromHotkey(
  key: string,
  companies: ScopeCompany[],
): CompanyScope | null {
  const k = key.toLowerCase();
  if (k === "0") return "all";
  if (k === "p") return "personal";
  if (/^[1-5]$/.test(k)) {
    const index = Number.parseInt(k, 10) - 1;
    const company = companies[index];
    return company ? company.companyUid : null;
  }
  return null;
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

/** Client-side search over titles for the history view — newest first. */
export function searchHistory(
  rows: ConversationRow[],
  query: string,
): ConversationRow[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? rows.filter((row) => row.title.toLowerCase().includes(q))
    : rows.slice();
  return hits.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
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
    const label = labelFor(row.lastActivityAt ?? 0);
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
  const photo = uid ? avatarByUid?.[uid] : undefined;
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
