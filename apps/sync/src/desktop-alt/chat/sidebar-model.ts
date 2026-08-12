/**
 * Pure model for the chat-first unified conversation sidebar (US-003).
 *
 * No Svelte / DOM — unit-tested with real dates. Normalizes channels + DMs into
 * rows, groups by day (TODAY / YESTERDAY / weekday / LAST WEEK collapse),
 * filters by company scope + show kind, sorts, and persists pins.
 */

import {
  channelDisplayName,
  type Channel,
  type ChannelParticipant,
} from '../../lib/channels';

// ── Row shape ────────────────────────────────────────────────────────────────

export type ConversationKind = 'channel' | 'dm' | 'group';

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
  /** Underlying person uid when kind is dm. */
  personUid?: string;
  email?: string | null;
}

/** Company option for the scope pill (order preserved from caller). */
export interface ScopeCompany {
  companyUid: string;
  label: string;
}

export type CompanyScope = 'all' | 'personal' | string;

export type SortMode = 'recent' | 'type';
export type ShowFilter = 'all' | 'projects' | 'dms';

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

export const PINS_STORAGE_KEY = 'hq.chat.pins';
export const CONVERSATION_CACHE_KEY = 'hq.chat.conversation-cache';
export const DM_DOTS_STORAGE_KEY = 'hq.chat.dm-dots';

// ── Timestamp helpers ────────────────────────────────────────────────────────

export function parseActivityMs(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

const WEEKDAYS = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const;

/** Format a day bucket label at `dayStart` relative to `now`. */
export function daySectionLabel(dayStart: number, now: number = Date.now()): string {
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  // Accept any timestamp in the day — normalize to local midnight.
  const bucket = startOfLocalDay(dayStart);
  const day = new Date(bucket);

  if (bucket === todayStart) {
    return `TODAY · ${MONTHS[day.getMonth()]} ${day.getDate()}`;
  }
  if (bucket === yesterdayStart) {
    return 'YESTERDAY';
  }
  // 2–7 days ago: weekday name.
  const ageDays = Math.floor((todayStart - bucket) / 86_400_000);
  if (ageDays >= 2 && ageDays <= 7) {
    return WEEKDAYS[day.getDay()];
  }
  // Older than a week: still produce a real date label if used as a section.
  return `${MONTHS[day.getMonth()]} ${day.getDate()}`;
}

/** Titlebar "DAY · DATE" chrome, e.g. "TUE · AUG 12". */
export function titlebarDayDate(now: number = Date.now()): string {
  const d = new Date(now);
  const day = WEEKDAYS[d.getDay()].slice(0, 3);
  return `${day} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
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

export interface NormalizeOptions {
  pinnedIds?: ReadonlySet<string> | readonly string[];
  /** Local DM activity dots (personUid set). Absent-safe. */
  dmDots?: ReadonlySet<string> | readonly string[];
  now?: number;
}

function toIdSet(value: ReadonlySet<string> | readonly string[] | undefined): Set<string> {
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
  const isGroup = channel.scope === 'group';
  const activity = Math.max(
    parseActivityMs(channel.lastActivityAt),
    parseActivityMs(channel.lastMessageAt),
    parseActivityMs(channel.createdAt),
    typeof channel.arrivedAt === 'number' ? channel.arrivedAt : 0,
  );
  const unread = Math.max(0, channel.unread ?? 0);

  return {
    id,
    kind: isGroup ? 'group' : 'channel',
    title: channelDisplayName(channel),
    companyUid:
      isGroup || channel.scope === 'personal'
        ? null
        : (channel.companyUid?.trim() || null),
    // Channels get a numeric badge when unread > 0; group DMs use a dot only
    // (no reliable per-pair unread story yet for people, but channels ship unread).
    unreadCount: !isGroup && unread > 0 ? unread : undefined,
    unreadDot: isGroup ? unread > 0 : false,
    lastActivityAt: activity,
    pinned: pinnedIds.has(id),
    memberCount: channel.memberCount,
    members: channel.members,
    channelId: channel.channelId,
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
    contact.displayName?.trim() ||
    contact.email?.trim() ||
    contact.personUid;
  const activity = Math.max(
    parseActivityMs(contact.lastMessageAt),
    parseActivityMs(contact.lastActivityAt),
    parseActivityMs(contact.lastDmAt),
  );
  const localDot = contact.activityDot === true || dmDots.has(contact.personUid);
  const serverUnread = contact.unreadCount;
  const hasServerUnread = typeof serverUnread === 'number' && Number.isFinite(serverUnread);
  const unreadCount =
    hasServerUnread && (serverUnread as number) > 0 ? Math.floor(serverUnread as number) : undefined;
  // Numeric badge replaces the server-driven dot; local dots still apply when
  // the server says zero (or when the field is absent and only local dots exist).
  const unreadDot = hasServerUnread
    ? (serverUnread as number) > 0
      ? false
      : localDot
    : localDot;

  return {
    id,
    kind: 'dm',
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

export function normalizeConversations(
  channels: Channel[],
  contacts: DmContactInput[],
  options: NormalizeOptions = {},
): ConversationRow[] {
  const rows: ConversationRow[] = [
    ...channels.map((c) => normalizeChannel(c, options)),
    ...contacts.map((c) => normalizeDm(c, options)),
  ];
  return rows;
}

// ── Filters + sort ───────────────────────────────────────────────────────────

export function filterByCompanyScope(
  rows: ConversationRow[],
  scope: CompanyScope,
): ConversationRow[] {
  if (scope === 'all') return rows.slice();
  if (scope === 'personal') {
    // Personal channels (companyUid null + kind channel) and DMs without a
    // company attachment. Group DMs stay visible under personal as direct chat.
    return rows.filter((row) => {
      if (row.kind === 'group') return true;
      if (row.kind === 'dm') return !row.companyUid;
      return !row.companyUid;
    });
  }
  // Specific company: that company's project channels + DMs tagged to it.
  return rows.filter((row) => {
    if (row.kind === 'group') return true; // group DMs are cross-company
    return row.companyUid === scope;
  });
}

export function filterByShow(
  rows: ConversationRow[],
  show: ShowFilter,
): ConversationRow[] {
  if (show === 'all') return rows.slice();
  if (show === 'projects') {
    return rows.filter((row) => row.kind === 'channel');
  }
  // DMs: 1:1 + group DMs
  return rows.filter((row) => row.kind === 'dm' || row.kind === 'group');
}

/** Filter to a single DM counterpart (personUid). */
export function filterByPerson(
  rows: ConversationRow[],
  personUid: string | null | undefined,
): ConversationRow[] {
  if (!personUid) return rows.slice();
  return rows.filter(
    (row) =>
      (row.kind === 'dm' && row.personUid === personUid) ||
      (row.kind === 'group' &&
        (row.members ?? []).some((m) => m.personUid === personUid)),
  );
}

export function sortConversations(
  rows: ConversationRow[],
  mode: SortMode,
): ConversationRow[] {
  const copy = rows.slice();
  if (mode === 'type') {
    const order: Record<ConversationKind, number> = {
      channel: 0,
      group: 1,
      dm: 2,
    };
    copy.sort((a, b) => {
      const kindDiff = order[a.kind] - order[b.kind];
      if (kindDiff !== 0) return kindDiff;
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
      return a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
    return copy;
  }
  // Recent
  copy.sort((a, b) => {
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt;
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
  next = filterByCompanyScope(next, options.scope ?? 'all');
  next = filterByShow(next, options.show ?? 'all');
  next = filterByPerson(next, options.personUid ?? null);
  return sortConversations(next, options.sort ?? 'recent');
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

// ── Scope pill cycling ───────────────────────────────────────────────────────

export type ScopeOption =
  | { id: 'all'; label: string }
  | { id: 'personal'; label: string }
  | { id: string; label: string; companyUid: string };

export function buildScopeOptions(companies: ScopeCompany[]): ScopeOption[] {
  const opts: ScopeOption[] = [{ id: 'all', label: 'All' }];
  for (const c of companies) {
    opts.push({ id: c.companyUid, label: c.label, companyUid: c.companyUid });
  }
  opts.push({ id: 'personal', label: 'Personal' });
  return opts;
}

/** Cycle All → companies… → Personal → All. */
export function nextScope(current: CompanyScope, companies: ScopeCompany[]): CompanyScope {
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
  if (k === '0') return 'all';
  if (k === 'p') return 'personal';
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
  if (scope === 'all') return 'All';
  if (scope === 'personal') return 'Personal';
  return companies.find((c) => c.companyUid === scope)?.label ?? 'Company';
}

// ── Pin persistence ──────────────────────────────────────────────────────────

export function loadPins(storage: Pick<Storage, 'getItem'> | null | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PINS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function savePins(
  ids: readonly string[],
  storage: Pick<Storage, 'setItem'> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(PINS_STORAGE_KEY, JSON.stringify([...ids]));
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

export function loadDmDots(storage: Pick<Storage, 'getItem'> | null | undefined): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(DM_DOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

export function saveDmDots(
  personUids: readonly string[],
  storage: Pick<Storage, 'setItem'> | null | undefined,
): void {
  if (!storage) return;
  try {
    storage.setItem(DM_DOTS_STORAGE_KEY, JSON.stringify([...personUids]));
  } catch {
    // best-effort
  }
}

export function clearDmDot(personUids: readonly string[], personUid: string): string[] {
  return personUids.filter((id) => id !== personUid);
}

// ── Conversation cache (cache-first sidebar paint) ───────────────────────────

export interface ConversationCachePayload {
  channels: Channel[];
  contacts: DmContactInput[];
  cachedAt: number;
}

export function loadConversationCache(
  storage: Pick<Storage, 'getItem'> | null | undefined,
): ConversationCachePayload | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONVERSATION_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ConversationCachePayload;
    if (!parsed || !Array.isArray(parsed.channels) || !Array.isArray(parsed.contacts)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveConversationCache(
  payload: ConversationCachePayload,
  storage: Pick<Storage, 'setItem'> | null | undefined,
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
    if (row.kind !== 'dm' || !row.personUid) continue;
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
        if (row.members?.some((m) => m.displayName.toLowerCase().includes(q))) return true;
        return false;
      })
    : rows;
  return sortConversations(base, 'recent').slice(0, limit);
}

/** Client-side search over titles for the history view. */
export function searchHistory(rows: ConversationRow[], query: string): ConversationRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter((row) => row.title.toLowerCase().includes(q));
}

/** Initials for avatar monograms (max 2). */
export function initialsFor(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`.toUpperCase() || '?';
  }
  return title.trim().slice(0, 2).toUpperCase() || '?';
}

// ── Command palette conversation ranking (US-013) ────────────────────────────

export type ConversationKindLabel = 'Channel' | 'DM' | 'Group';

/** Human type tag for palette / search result rows. */
export function conversationKindLabel(kind: ConversationKind): ConversationKindLabel {
  if (kind === 'channel') return 'Channel';
  if (kind === 'group') return 'Group';
  return 'DM';
}

/**
 * Match score for palette ranking. Higher is better.
 *  - 3: title starts with query
 *  - 2: title contains query
 *  - 1: email / member name contains query
 *  - 0: no match (caller usually filters these out when query is non-empty)
 */
export function conversationQueryScore(row: ConversationRow, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1; // empty query: treat as weakly matched so recency can rank
  const title = row.title.toLowerCase();
  if (title.startsWith(q)) return 3;
  if (title.includes(q)) return 2;
  if (row.email?.toLowerCase().includes(q)) return 1;
  if (row.members?.some((m) => m.displayName.toLowerCase().includes(q))) return 1;
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
    return a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id);
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
  scope: 'dm' | 'channel' | string;
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
  if (scope === 'all' || scope === 'personal') return null;
  const uid = scope.trim();
  return uid || null;
}

/** Scope label shown near the all-history search input. */
export function historySearchScopeLabel(
  scope: CompanyScope,
  companies: ScopeCompany[],
): string {
  if (scope === 'all') return 'All companies';
  if (scope === 'personal') return 'Personal';
  return companies.find((c) => c.companyUid === scope)?.label ?? 'Company';
}

/** Prefer snippet, fall back to body. */
export function searchHitSnippet(hit: MessageSearchHit): string {
  const snippet = hit.snippet?.trim();
  if (snippet) return snippet;
  return hit.body?.trim() || '';
}

/**
 * Map a search hit onto a local ConversationRow when possible (title + kind).
 * Falls back to a synthetic row from hit metadata so the UI can still open.
 */
export function resolveSearchHitRow(
  hit: MessageSearchHit,
  rows: ConversationRow[],
): ConversationRow {
  if (hit.scope === 'dm' && hit.counterpartyUid) {
    const existing = rows.find(
      (r) => r.kind === 'dm' && r.personUid === hit.counterpartyUid,
    );
    if (existing) return existing;
    return {
      id: `dm:${hit.counterpartyUid}`,
      kind: 'dm',
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
        (r.kind === 'channel' || r.kind === 'group') && r.channelId === hit.channelId,
    );
    if (existing) return existing;
    return {
      id: `ch:${hit.channelId}`,
      kind: 'channel',
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
    kind: hit.scope === 'dm' ? 'dm' : 'channel',
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
  if (!ms) return '';
  const todayStart = startOfLocalDay(now);
  const yesterdayStart = todayStart - 86_400_000;
  const day = startOfLocalDay(ms);
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  if (day === todayStart) return time;
  if (day === yesterdayStart) return `Yesterday ${time}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}
