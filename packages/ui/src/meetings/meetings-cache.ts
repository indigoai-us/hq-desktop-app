/**
 * Per-window localStorage cache for the Meetings window.
 *
 * The Meetings window historically fetched four Tauri commands in parallel
 * on mount (`meetings_list_upcoming`, `_scheduled_bots`, `_memberships`,
 * `_accounts`) plus a per-account calendar fan-out, then flipped a skeleton
 * to the populated list. On a typical install that's a noticeable hang —
 * users see "loading…" for a few hundred ms each time they reopen the
 * window, even though the data they saw on last open was almost certainly
 * still valid.
 *
 * This module is the stale-while-revalidate seam: snapshot last-known state
 * on every successful refresh, replay it synchronously at next script-init
 * so the first paint already has rows, then let the in-flight refresh swap
 * in fresh data when it lands. Maps and Sets are serialized as arrays so
 * the cached payload survives `JSON.stringify`.
 *
 * Kept pure (no Tauri/Svelte imports) so it can be unit-tested in isolation
 * and so the hydration path can't fail in a way that takes the whole window
 * down — every accessor swallows `localStorage` errors and returns null,
 * which the caller treats as "no cache, render the normal skeleton".
 */

/** Bump on every breaking change to the cached shape so old entries from a
 *  previous app version are treated as a cache miss instead of crashing
 *  the hydration path with a shape mismatch. */
const SCHEMA_VERSION = 2;

/** localStorage key. Namespaced with the schema version so a future bump
 *  doesn't have to manually delete the prior entry — old keys just rot
 *  harmlessly until the browser evicts them. */
const STORAGE_KEY = `hq-sync:meetings-window:v${SCHEMA_VERSION}`;

/** Upper bound on cache age. A stale snapshot still paints at once and the
 *  background refresh upgrades it in place (rows are grouped against the
 *  current clock, so old events fall into the past sections). A 24h bound
 *  turned every visit after a missed write into a cold multi-second load. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MeetingsStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Shape of one snapshot. Mirrors the `$state` variables in
 *  MeetingsWindow.svelte that `refresh()` populates. Maps and Sets are
 *  encoded as their `Array.from()` form so `JSON.stringify` roundtrips
 *  cleanly — `JSON.stringify(new Map())` returns `"{}"`, which is useless. */
export interface MeetingsSnapshot<
  TEvent = unknown,
  TBot = unknown,
  TAccount = unknown,
  TCalendar = unknown,
> {
  events: TEvent[];
  /** Full scheduled-bot list. Lets recurring instances hydrate against
   *  series-level bots whose calendarEventId belongs to another occurrence. */
  scheduledBots?: TBot[];
  /** [calendarEventId, bot] entries — deserialized into a Map by the caller.
   *  Writers may leave this empty: it duplicates scheduledBots and the
   *  reader rebuilds it from them. */
  botsByEventId: Array<[string, TBot]>;
  /** [companyUid, companyName] entries. */
  companyNamesByUid: Array<[string, string]>;
  accounts: TAccount[];
  /** [accountId, email] entries. */
  accountEmailById: Array<[string, string]>;
  /** [accountId, calendars] entries. */
  calendarsByAccount: Array<[string, TCalendar[]]>;
  /** [accountId, calendarIds] entries — calendarIds is the Set encoded
   *  as a plain array. */
  enabledCalIdsByAccount: Array<[string, string[]]>;
  /** [calKey, summary] entries — calKey is `${accountId}|${calendarId}`. */
  calendarSummaryByKey: Array<[string, string]>;
  /** Recorded meeting history rows (already coerced). */
  recorded?: unknown[];
}

interface CacheEnvelope<TSnap> {
  version: number;
  cachedAt: number;
  snapshot: TSnap;
}

/**
 * Read the last snapshot. Returns null on any failure path so callers can
 * treat hydration as best-effort — a corrupt entry, a privacy-mode browser
 * with localStorage disabled, or a schema-version mismatch all collapse to
 * the same "no cache" outcome and the normal cold-start skeleton renders.
 */
export function loadMeetingsCache<
  TEvent = unknown,
  TBot = unknown,
  TAccount = unknown,
  TCalendar = unknown,
>(storage: MeetingsStorage | null | undefined = globalThis.localStorage): MeetingsSnapshot<TEvent, TBot, TAccount, TCalendar> | null {
  try {
    const raw = safeGetItem(storage, STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<
      MeetingsSnapshot<TEvent, TBot, TAccount, TCalendar>
    >;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== SCHEMA_VERSION) return null;
    if (typeof parsed.cachedAt !== "number") return null;
    if (Date.now() - parsed.cachedAt > MAX_AGE_MS) return null;
    if (!parsed.snapshot || typeof parsed.snapshot !== "object") return null;
    return parsed.snapshot;
  } catch {
    return null;
  }
}

/**
 * Write the snapshot. Best-effort — silently swallows quota errors and
 * other localStorage failures so a write failure can never break the
 * refresh path (the user still sees the freshly-loaded data, they just
 * won't get the cache benefit on next open).
 */
export function saveMeetingsCache<
  TEvent = unknown,
  TBot = unknown,
  TAccount = unknown,
  TCalendar = unknown,
>(
  snapshot: MeetingsSnapshot<TEvent, TBot, TAccount, TCalendar>,
  storage: MeetingsStorage | null | undefined = globalThis.localStorage,
): boolean {
  if (!storage) return false;
  let raw: string;
  try {
    raw = JSON.stringify({ version: SCHEMA_VERSION, cachedAt: Date.now(), snapshot } satisfies CacheEnvelope<typeof snapshot>);
  } catch (err) {
    console.warn("[meetings-cache] snapshot not serializable:", err);
    return false;
  }
  // A full origin quota makes setItem fail, and tenant-scoped storage
  // wrappers swallow that error. Verify by reading back; on a miss drop our
  // own previous entry (the largest thing we can free) and try once more.
  if (writeVerified(storage, raw)) return true;
  try {
    safeRemoveItem(storage, STORAGE_KEY);
  } catch {
    // Fall through to the retry; its result is what we report.
  }
  if (writeVerified(storage, raw)) return true;
  console.warn(`[meetings-cache] snapshot write failed (${raw.length} chars); next open will load from the network`);
  return false;
}

function writeVerified(storage: MeetingsStorage, raw: string): boolean {
  try {
    safeSetItem(storage, STORAGE_KEY, raw);
    return safeGetItem(storage, STORAGE_KEY)?.length === raw.length;
  } catch {
    return false;
  }
}

/** Wipe the cached snapshot. Exposed for tests and for any future
 *  "sign out" path that needs to drop user-scoped data. */
export function clearMeetingsCache(
  storage: MeetingsStorage | null | undefined = globalThis.localStorage,
): void {
  try {
    safeRemoveItem(storage, STORAGE_KEY);
  } catch {
    // No-op.
  }
}

// ─────────────────────────────────────────────────────────────────────────
// localStorage shims
//
// Wrap localStorage access so the module never throws on the server (vitest
// `jsdom` env has localStorage, but node-env tests won't) and so we always
// have a single chokepoint to swallow `SecurityError` / `QuotaExceededError`
// — the two common failure modes when running inside a hardened webview.
// ─────────────────────────────────────────────────────────────────────────

function safeGetItem(storage: MeetingsStorage | null | undefined, key: string): string | null {
  if (!storage) return null;
  return storage.getItem(key);
}

function safeSetItem(
  storage: MeetingsStorage | null | undefined,
  key: string,
  value: string,
): void {
  if (!storage) return;
  storage.setItem(key, value);
}

function safeRemoveItem(storage: MeetingsStorage | null | undefined, key: string): void {
  if (!storage) return;
  storage.removeItem(key);
}
