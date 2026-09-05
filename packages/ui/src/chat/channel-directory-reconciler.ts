/**
 * Channel-directory reconciler — the desktop adoption of the channel fabric
 * (US-009), ported from the hq-mobile Work Mesh reconciler pattern
 * (hq-mobile src/work-mesh/reconciler.ts).
 *
 * The sidebar no longer refetches `list_channels` in a loop. Instead it
 * consumes `GET /v1/notify/channels?cursor` (via the Rust command
 * `fetch_channel_directory`) as a snapshot/delta feed of server-shaped
 * directory rows:
 *
 *  - no cursor (or an expired/invalid/epoch-bumped one) → full snapshot +
 *    fresh cursor (`reset: true` on recovery — NEVER an error loop);
 *  - a valid cursor → only `changed` rows + `removedChannelIds` + a
 *    successor cursor.
 *
 * Mobile-pattern properties kept intact:
 *  - lifecycle-epoch safety: `invalidate()`/`stop()` bump an epoch so a
 *    stale in-flight apply can never clobber newer state;
 *  - coalesced reconciles: overlapping wake bursts fold into one in-flight
 *    run plus at most one trailing run;
 *  - persisted, validated cursor (token shape + client-side expiry) so a
 *    warm restart delta-fetches instead of re-snapshotting;
 *  - expired-cursor contract check on the response;
 *  - a safety refetch (`setSafetyPolling`) only while MQTT is down; connect
 *    and focus run cursor catch-up instead.
 *
 * Pure DI (no Svelte, no Tauri imports) so every behavior is unit-testable.
 */

// ── Wire shapes (mirror hq-pro channel-directory-feed.ts / Rust) ─────────────

/** One server-shaped directory row. `lastActivityAt` is `null` for a channel
 * with no durable messages — never fabricate a timestamp for it (an empty
 * channel must NEVER bucket under "today"). */
export interface ChannelDirectoryRow {
  channelId: string;
  /** Fabric taxonomy: "chat" | "dm" | "project". */
  type?: string;
  /** "personal" | "company" | "group" | "project". */
  scope: string;
  companyUid?: string | null;
  /** Company display name, when the directory carries it (company channels). */
  companyName?: string | null;
  /**
   * Owning company's website favicon, presigned by hq-pro on the assets host
   * (CSP-safe to paint). `null` = the company has no icon; ABSENT = the field
   * is not served (older server) — both fall back to the building glyph, so a
   * client never needs to tell them apart.
   */
  iconUrl?: string | null;
  /** Bound work-mesh / board project when the server sent one. */
  projectId?: string | null;
  /** Display name ("" for participant-keyed group DMs). */
  name: string;
  /** Server-computed subtitle label. */
  subtitle?: string;
  lastActivityAt: string | null;
  /** Notify-channel created stamp — sidebar fallback when activity is a provision clone. */
  createdAt?: string | null;
  /** Notify-channel updated stamp — used to detect doctor/ensure "now" clones. */
  updatedAt?: string | null;
  unreadCount?: number;
  mentionFlag?: boolean;
  memberCount?: number;
  /** Group-DM roster (caller excluded) so the rail can name unnamed chats. */
  members?: Array<{ personUid: string; displayName: string }>;
}

/** The contractVersion-2 snapshot/delta envelope. */
export interface ChannelDirectoryFeed {
  contractVersion?: number;
  snapshot: boolean;
  reset?: boolean;
  cursor: string;
  cursorExpiresAt: string;
  removedChannelIds?: string[];
  rows?: ChannelDirectoryRow[];
  changed?: ChannelDirectoryRow[];
}

// ── Cursor persistence ───────────────────────────────────────────────────────

export const CHANNEL_DIRECTORY_CURSOR_KEY = "hq.chat.channel-directory-cursor";
const CURSOR_STORAGE_VERSION = 1;
/** Same token shape the server mints (base64url, 32–128 chars). */
const CURSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface DirectoryCursorStorage {
  load(): string | undefined;
  save(cursor: string, expiresAt: string): void;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * localStorage-backed cursor persistence with the mobile validation rules:
 * versioned envelope, token-shape check, and client-side expiry — a stale or
 * malformed record degrades to "no cursor" (fresh snapshot), never an error.
 */
export function localDirectoryCursorStorage(
  storage: StorageLike | null | undefined,
  now: () => number = Date.now,
): DirectoryCursorStorage {
  return {
    load() {
      if (!storage) return undefined;
      try {
        const raw = storage.getItem(CHANNEL_DIRECTORY_CURSOR_KEY);
        if (!raw) return undefined;
        const value = JSON.parse(raw) as Record<string, unknown>;
        return value.version === CURSOR_STORAGE_VERSION &&
          typeof value.cursor === "string" &&
          CURSOR_TOKEN_PATTERN.test(value.cursor) &&
          typeof value.expiresAt === "string" &&
          Date.parse(value.expiresAt) > now()
          ? value.cursor
          : undefined;
      } catch {
        return undefined;
      }
    },
    save(cursor, expiresAt) {
      if (!storage) return;
      if (
        !CURSOR_TOKEN_PATTERN.test(cursor) ||
        !(Date.parse(expiresAt) > now())
      ) {
        return; // Never persist an invalid/expired cursor.
      }
      try {
        storage.setItem(
          CHANNEL_DIRECTORY_CURSOR_KEY,
          JSON.stringify({
            version: CURSOR_STORAGE_VERSION,
            cursor,
            expiresAt,
          }),
        );
      } catch {
        // Quota / private mode — best-effort; next run re-snapshots.
      }
    },
  };
}

// ── Reconciler ───────────────────────────────────────────────────────────────

export type ChannelDirectoryReconcileStatus =
  | "idle"
  | "reconciling"
  | "ready"
  | "offline"
  | "auth_blocked"
  | "contract_error"
  | "retryable_error";

export type ChannelDirectoryReconcileReason =
  "startup" | "wake" | "interval" | "manual" | "catchup";

/**
 * The safety-refetch interval (requirement 5): even if every wake is lost,
 * the sidebar converges within this bound. Well inside the 15-minute cursor
 * TTL so the persisted cursor stays warm (each pass mints a successor).
 */
export const CHANNEL_DIRECTORY_SAFETY_REFETCH_MS = 3 * 60_000;

export class ChannelDirectoryContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelDirectoryContractError";
  }
}

export interface ChannelDirectoryReconcilerOptions {
  /** The desktop `fetch_channel_directory` command / web GET /v1/notify/channels. */
  fetchFeed: (cursor?: string) => Promise<ChannelDirectoryFeed>;
  /** Receives the full reconciled row list after every successful run. */
  onApply: (rows: ChannelDirectoryRow[]) => void;
  onStatus?: (status: ChannelDirectoryReconcileStatus) => void;
  onError?: (error: Error) => void;
  storage?: DirectoryCursorStorage;
  now?: () => number;
  /** Safety-refetch period; injectable for tests. */
  safetyIntervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface ChannelDirectoryReconciler {
  /** Coalesced reconcile; resolves when the (possibly folded) run settles. */
  reconcile(reason?: ChannelDirectoryReconcileReason): Promise<void>;
  /** Arm the periodic safety refetch (idempotent). */
  start(): void;
  /**
   * Arm the interval only when MQTT is down. While the socket is healthy,
   * wakes + cursor catch-up are enough — do not poll.
   */
  setSafetyPolling(enabled: boolean): void;
  /** Tear down: disarm the interval, invalidate in-flight applies. */
  stop(): void;
  /** Bump the lifecycle epoch — a stale in-flight run can no longer apply. */
  invalidate(): void;
  status(): ChannelDirectoryReconcileStatus;
  snapshot(): ChannelDirectoryRow[];
  /**
   * Drop one row from the local cache (optimistic delete). Without this the
   * next reconcile would re-apply the cached row until the server's delta
   * lists it in `removedChannelIds`; that delta remains authoritative.
   */
  forget(channelId: string): void;
}

const noopStorage: DirectoryCursorStorage = {
  load: () => undefined,
  save: () => {},
};

/** Sort mirrors the server: lastActivityAt desc (empty channels last),
 * channelId asc as the stable tiebreak. */
export function sortDirectoryRows(
  rows: ChannelDirectoryRow[],
): ChannelDirectoryRow[] {
  return rows
    .slice()
    .sort(
      (a, b) =>
        (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
        a.channelId.localeCompare(b.channelId),
    );
}

export function createChannelDirectoryReconciler(
  options: ChannelDirectoryReconcilerOptions,
): ChannelDirectoryReconciler {
  const {
    fetchFeed,
    onApply,
    onStatus,
    onError,
    storage = noopStorage,
    now = Date.now,
    safetyIntervalMs = CHANNEL_DIRECTORY_SAFETY_REFETCH_MS,
  } = options;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let lifecycleEpoch = 0;
  let stopped = false;
  let running = false;
  let trailing = false;
  let activePromise: Promise<void> = Promise.resolve();
  let cursor: string | undefined;
  let cursorLoaded = false;
  let initialized = false;
  let currentStatus: ChannelDirectoryReconcileStatus = "idle";
  let byId = new Map<string, ChannelDirectoryRow>();
  let safetyTimer: ReturnType<typeof setInterval> | null = null;

  function transition(next: ChannelDirectoryReconcileStatus): void {
    currentStatus = next;
    onStatus?.(next);
  }

  function isCurrent(epoch: number): boolean {
    return !stopped && lifecycleEpoch === epoch;
  }

  async function runOnce(): Promise<void> {
    const epoch = lifecycleEpoch;
    transition("reconciling");
    try {
      if (!cursorLoaded) {
        cursor = storage.load();
        cursorLoaded = true;
      }
      const feed = await fetchFeed(cursor);
      if (!isCurrent(epoch)) return;
      if (!(Date.parse(feed.cursorExpiresAt) > now())) {
        throw new ChannelDirectoryContractError(
          "Channel directory feed returned an expired cursor.",
        );
      }
      if (feed.snapshot || !initialized) {
        // Full snapshot (also the recovery path for reset: true) replaces
        // everything the client painted.
        byId = new Map((feed.rows ?? []).map((row) => [row.channelId, row]));
      } else {
        const next = new Map(byId);
        for (const removed of feed.removedChannelIds ?? [])
          next.delete(removed);
        for (const changed of feed.changed ?? [])
          next.set(changed.channelId, changed);
        byId = next;
      }
      onApply(sortDirectoryRows([...byId.values()]));
      if (!isCurrent(epoch)) return;
      storage.save(feed.cursor, feed.cursorExpiresAt);
      cursor = feed.cursor;
      initialized = true;
      transition("ready");
    } catch (error) {
      if (!isCurrent(epoch)) return;
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      transition(classifyFailure(normalized));
      onError?.(normalized);
      throw normalized;
    }
  }

  function reconcile(
    reason: ChannelDirectoryReconcileReason = "manual",
  ): Promise<void> {
    void reason;
    if (stopped) return Promise.resolve();
    if (running) {
      // Fold into the in-flight run: it re-runs once more when it finishes,
      // so a wake that raced the fetch is never lost.
      trailing = true;
      return activePromise;
    }
    running = true;
    // Starts SYNCHRONOUSLY (async IIFE runs to its first await) so the feed
    // fetch is issued on the same tick as the caller — the US-020 first-paint
    // harness asserts the background refresh was kicked off before any
    // microtask settles.
    activePromise = (async () => {
      let failure: Error | undefined;
      do {
        trailing = false;
        try {
          await runOnce();
          failure = undefined;
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      } while (trailing && !stopped);
      if (failure) throw failure;
    })().finally(() => {
      running = false;
    });
    return activePromise;
  }

  function setSafetyPolling(enabled: boolean): void {
    if (stopped) return;
    if (enabled) {
      if (safetyTimer !== null) return;
      safetyTimer = setIntervalFn(() => {
        // Errors already reach onError/status; the interval must never
        // produce an unhandled rejection.
        void reconcile("interval").catch(() => {});
      }, safetyIntervalMs);
      return;
    }
    if (safetyTimer !== null) {
      clearIntervalFn(safetyTimer);
      safetyTimer = null;
    }
  }

  return {
    reconcile,
    start() {
      setSafetyPolling(true);
    },
    setSafetyPolling,
    stop() {
      stopped = true;
      lifecycleEpoch += 1;
      trailing = false;
      if (safetyTimer !== null) {
        clearIntervalFn(safetyTimer);
        safetyTimer = null;
      }
      transition("idle");
    },
    invalidate() {
      lifecycleEpoch += 1;
      trailing = running;
    },
    status: () => currentStatus,
    snapshot: () => sortDirectoryRows([...byId.values()]),
    forget(channelId) {
      byId.delete(channelId);
    },
  };
}

function classifyFailure(error: Error): ChannelDirectoryReconcileStatus {
  if (error instanceof ChannelDirectoryContractError) return "contract_error";
  // Rust command rejections arrive as strings (normalized to Error above);
  // map the auth_and_base / get_json prefixes onto mobile's status taxonomy.
  const message = error.message;
  if (message.startsWith("Not signed in")) return "auth_blocked";
  if (error instanceof TypeError || message.startsWith("Network error")) {
    return "offline";
  }
  return "retryable_error";
}
