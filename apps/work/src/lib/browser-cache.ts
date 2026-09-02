/**
 * Browser rail cache for the hosted web shell.
 *
 * One localStorage blob per signed-in person: every project, chat, and DM
 * the last hydrate assembled. First paint reads this. MQTT/REST writes
 * back into it. Not a clone of ~/.hq/work-mesh.
 */

import {
  applyDirectoryRows,
  saveConversationCache,
  type ChannelDirectoryRow,
  type ChatSidebarApi,
  type ConversationMessageWire,
  type DmContactInput,
} from "@hq/ui";

export const SHALLOW_CACHE_KEY = "hq.web.rail-cache.v4";
export const SHALLOW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_DIRECTORY_ROWS = 800;
export const MAX_CONTACTS = 200;
export const MAX_THREAD_MESSAGES = 40;
/** Huge agent dumps must not be stringified into localStorage on every send. */
export const MAX_CACHED_BODY_CHARS = 4_000;

export interface ShallowLastThread {
  key: string;
  messages: ConversationMessageWire[];
}

export interface ShallowBrowserCache {
  personUid: string;
  savedAt: number;
  directory: ChannelDirectoryRow[];
  contacts: DmContactInput[];
  lastThread: ShallowLastThread | null;
  /** ConversationRow.id last opened in this browser (`ch:…` / `dm:…`). */
  lastSelectedId: string | null;
}

export const EMPTY_SHALLOW_CACHE: ShallowBrowserCache = {
  personUid: "",
  savedAt: 0,
  directory: [],
  contacts: [],
  lastThread: null,
  lastSelectedId: null,
};

export interface ShallowCacheStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function now(): number {
  return Date.now();
}

export function isShallowCacheFresh(
  cache: ShallowBrowserCache,
  personUid: string,
  atMs: number = now(),
): boolean {
  if (!cache.personUid || cache.personUid !== personUid) return false;
  if (!cache.savedAt) return false;
  return atMs - cache.savedAt <= SHALLOW_CACHE_TTL_MS;
}

function capDirectory(rows: ChannelDirectoryRow[]): ChannelDirectoryRow[] {
  return rows.slice(0, MAX_DIRECTORY_ROWS);
}

function capContacts(rows: DmContactInput[]): DmContactInput[] {
  return rows.slice(0, MAX_CONTACTS);
}

function capCachedBody(body: string): string {
  if (body.length <= MAX_CACHED_BODY_CHARS) return body;
  return `${body.slice(0, MAX_CACHED_BODY_CHARS)}\n…`;
}

function capThread(thread: ShallowLastThread | null): ShallowLastThread | null {
  if (!thread?.key) return null;
  return {
    key: thread.key,
    messages: thread.messages.slice(-MAX_THREAD_MESSAGES).map((message) => ({
      ...message,
      body:
        typeof message.body === "string"
          ? capCachedBody(message.body)
          : message.body,
    })),
  };
}

export function mergeShallowCache(
  current: ShallowBrowserCache,
  patch: Partial<Omit<ShallowBrowserCache, "personUid" | "savedAt">>,
  personUid: string,
  atMs: number = now(),
): ShallowBrowserCache {
  return {
    personUid,
    savedAt: atMs,
    directory: capDirectory(patch.directory ?? current.directory),
    contacts: capContacts(patch.contacts ?? current.contacts),
    lastThread:
      patch.lastThread === undefined
        ? current.lastThread
        : capThread(patch.lastThread),
    lastSelectedId:
      patch.lastSelectedId === undefined
        ? current.lastSelectedId
        : patch.lastSelectedId,
  };
}

export function readShallowCache(
  personUid: string,
  storage: ShallowCacheStorage | null = defaultStorage(),
  atMs: number = now(),
): ShallowBrowserCache {
  if (!personUid || !storage) return EMPTY_SHALLOW_CACHE;
  try {
    const raw = storage.getItem(SHALLOW_CACHE_KEY);
    if (!raw) return EMPTY_SHALLOW_CACHE;
    const parsed = JSON.parse(raw) as ShallowBrowserCache;
    if (!parsed || typeof parsed !== "object") return EMPTY_SHALLOW_CACHE;
    const cache: ShallowBrowserCache = {
      personUid: typeof parsed.personUid === "string" ? parsed.personUid : "",
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      directory: Array.isArray(parsed.directory) ? parsed.directory : [],
      contacts: Array.isArray(parsed.contacts) ? parsed.contacts : [],
      lastThread: parsed.lastThread ?? null,
      lastSelectedId:
        typeof parsed.lastSelectedId === "string" && parsed.lastSelectedId
          ? parsed.lastSelectedId
          : (parsed.lastThread?.key ?? null),
    };
    if (!isShallowCacheFresh(cache, personUid, atMs))
      return EMPTY_SHALLOW_CACHE;
    return cache;
  } catch {
    return EMPTY_SHALLOW_CACHE;
  }
}

export function writeShallowCache(
  cache: ShallowBrowserCache,
  storage: ShallowCacheStorage | null = defaultStorage(),
): void {
  if (!storage || !cache.personUid) return;
  try {
    storage.setItem(SHALLOW_CACHE_KEY, JSON.stringify(cache));
  } catch {
    try {
      storage.removeItem(SHALLOW_CACHE_KEY);
    } catch {
      /* quota / private mode */
    }
  }
}

export function clearShallowCache(
  storage: ShallowCacheStorage | null = defaultStorage(),
): void {
  try {
    storage?.removeItem(SHALLOW_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/** Persist the last open REST timeline for first-paint on the next visit. */
export function persistLastThread(
  personUid: string,
  key: string,
  messages: ConversationMessageWire[],
  storage: ShallowCacheStorage | null = defaultStorage(),
): void {
  if (!personUid || !key) return;
  const current = readShallowCache(personUid, storage);
  writeShallowCache(
    mergeShallowCache(
      current,
      { lastThread: { key, messages }, lastSelectedId: key },
      personUid,
    ),
    storage,
  );
}

/** Remember the conversation the user last opened so a fresh load can restore it. */
export function persistLastSelected(
  personUid: string,
  rowId: string,
  storage: ShallowCacheStorage | null = defaultStorage(),
): void {
  if (!personUid || !rowId) return;
  const current = readShallowCache(personUid, storage);
  writeShallowCache(
    mergeShallowCache(current, { lastSelectedId: rowId }, personUid),
    storage,
  );
}

/**
 * Preferred conversation on a fresh load: last selected row if it still
 * exists, else the last hydrated thread, else the most recently active
 * directory row.
 */
export function resolveLastSelectedId(
  cache: ShallowBrowserCache,
): string | null {
  return cache.lastSelectedId || cache.lastThread?.key || null;
}

export function pickMostRecentDirectoryRow(
  rows: readonly ChannelDirectoryRow[],
): ChannelDirectoryRow | null {
  if (rows.length === 0) return null;
  let best = rows[0]!;
  let bestAt = Date.parse(best.lastActivityAt ?? "") || 0;
  for (const row of rows.slice(1)) {
    const at = Date.parse(row.lastActivityAt ?? "") || 0;
    if (at > bestAt) {
      best = row;
      bestAt = at;
    }
  }
  return best;
}

/** Paint ChatSidebar from the rail cache on the next mount. */
export function seedConversationCacheFromRail(
  cache: ShallowBrowserCache,
  storage: ShallowCacheStorage | null = defaultStorage(),
): void {
  if (
    !storage ||
    (cache.directory.length === 0 && cache.contacts.length === 0)
  ) {
    return;
  }
  saveConversationCache(
    {
      channels: applyDirectoryRows(cache.directory, []),
      contacts: cache.contacts,
      cachedAt: cache.savedAt,
    },
    storage,
  );
}

/** Persist live directory/contacts into the rail blob after a REST fetch. */
export function persistShallowSidebar(
  api: ChatSidebarApi,
  personUid: string,
): ChatSidebarApi {
  if (!personUid) return api;
  return {
    ...api,
    fetchChannelDirectory: async (cursor) => api.fetchChannelDirectory(cursor),
    listContacts: async () => api.listContacts(),
  };
}

function defaultStorage(): ShallowCacheStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}
