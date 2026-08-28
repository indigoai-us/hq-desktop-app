/**
 * US-009 — channel-directory reconciler (mobile Work Mesh port).
 *
 * Covers: snapshot apply, delta apply (changed upserts + removed deletes),
 * cursor persistence + validation (shape, expiry, version), expired-cursor
 * contract error, reset-snapshot recovery, wake coalescing (in-flight run
 * folds a trailing run), epoch invalidation (stale applies dropped), the
 * periodic safety refetch, and failure classification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_DIRECTORY_CURSOR_KEY,
  CHANNEL_DIRECTORY_SAFETY_REFETCH_MS,
  createChannelDirectoryReconciler,
  localDirectoryCursorStorage,
  sortDirectoryRows,
  type ChannelDirectoryFeed,
  type ChannelDirectoryRow,
} from "./channel-directory-reconciler";

const NOW = Date.parse("2026-08-13T09:00:00.000Z");
const CURSOR_A = "a".repeat(43);
const CURSOR_B = "b".repeat(43);
const EXPIRES = new Date(NOW + 15 * 60_000).toISOString();

function row(
  channelId: string,
  overrides: Partial<ChannelDirectoryRow> = {},
): ChannelDirectoryRow {
  return {
    channelId,
    type: "chat",
    scope: "company",
    companyUid: "cmp_1",
    name: channelId,
    subtitle: "Company channel",
    lastActivityAt: "2026-08-13T08:00:00.000Z",
    unreadCount: 0,
    mentionFlag: false,
    memberCount: 2,
    ...overrides,
  };
}

function snapshotFeed(
  rows: ChannelDirectoryRow[],
  cursor = CURSOR_A,
): ChannelDirectoryFeed {
  return {
    contractVersion: 2,
    snapshot: true,
    reset: false,
    cursor,
    cursorExpiresAt: EXPIRES,
    removedChannelIds: [],
    rows,
    changed: [],
  };
}

function deltaFeed(
  changed: ChannelDirectoryRow[],
  removed: string[] = [],
  cursor = CURSOR_B,
): ChannelDirectoryFeed {
  return {
    contractVersion: 2,
    snapshot: false,
    reset: false,
    cursor,
    cursorExpiresAt: EXPIRES,
    removedChannelIds: removed,
    rows: [],
    changed,
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

describe("localDirectoryCursorStorage", () => {
  it("round-trips a valid cursor and rejects malformed / expired records", () => {
    const backing = memoryStorage();
    const storage = localDirectoryCursorStorage(backing, () => NOW);

    storage.save(CURSOR_A, EXPIRES);
    expect(storage.load()).toBe(CURSOR_A);

    // Token shape enforced on save…
    storage.save("short", EXPIRES);
    expect(storage.load()).toBe(CURSOR_A); // unchanged
    // …and expiry enforced on load.
    backing.data.set(
      CHANNEL_DIRECTORY_CURSOR_KEY,
      JSON.stringify({
        version: 1,
        cursor: CURSOR_B,
        expiresAt: new Date(NOW - 1000).toISOString(),
      }),
    );
    expect(storage.load()).toBeUndefined();
    // Wrong version → no cursor.
    backing.data.set(
      CHANNEL_DIRECTORY_CURSOR_KEY,
      JSON.stringify({ version: 99, cursor: CURSOR_B, expiresAt: EXPIRES }),
    );
    expect(storage.load()).toBeUndefined();
    // Garbage → no cursor, no throw.
    backing.data.set(CHANNEL_DIRECTORY_CURSOR_KEY, "{not json");
    expect(storage.load()).toBeUndefined();
  });

  it("never persists an expired cursor", () => {
    const backing = memoryStorage();
    const storage = localDirectoryCursorStorage(backing, () => NOW);
    storage.save(CURSOR_A, new Date(NOW - 1).toISOString());
    expect(backing.data.has(CHANNEL_DIRECTORY_CURSOR_KEY)).toBe(false);
  });
});

describe("createChannelDirectoryReconciler", () => {
  it("applies a snapshot, persists the cursor, then delta-fetches with it", async () => {
    const applied: ChannelDirectoryRow[][] = [];
    const cursors: Array<string | undefined> = [];
    const backing = memoryStorage();
    const fetchFeed = vi
      .fn()
      .mockImplementationOnce(async (cursor?: string) => {
        cursors.push(cursor);
        return snapshotFeed([
          row("ch_a"),
          row("ch_b", { lastActivityAt: null }),
        ]);
      })
      .mockImplementationOnce(async (cursor?: string) => {
        cursors.push(cursor);
        return deltaFeed(
          [
            row("ch_c", {
              lastActivityAt: "2026-08-13T08:30:00.000Z",
              unreadCount: 1,
            }),
          ],
          ["ch_b"],
        );
      });
    const r = createChannelDirectoryReconciler({
      fetchFeed,
      onApply: (rows) => applied.push(rows),
      storage: localDirectoryCursorStorage(backing, () => NOW),
      now: () => NOW,
    });

    await r.reconcile("startup");
    expect(cursors[0]).toBeUndefined();
    expect(applied[0].map((x) => x.channelId)).toEqual(["ch_a", "ch_b"]);
    expect(r.status()).toBe("ready");

    await r.reconcile("wake");
    // The delta run presented the persisted snapshot cursor…
    expect(cursors[1]).toBe(CURSOR_A);
    // …and folded changed + removed into the row set.
    expect(applied[1].map((x) => x.channelId)).toEqual(["ch_c", "ch_a"]);
    expect(applied[1][0].unreadCount).toBe(1);
  });

  it("an expired/invalidated cursor recovers by reset snapshot (never an error)", async () => {
    const applied: ChannelDirectoryRow[][] = [];
    const fetchFeed = vi
      .fn()
      .mockResolvedValueOnce(snapshotFeed([row("ch_a")]))
      .mockResolvedValueOnce({
        ...snapshotFeed([row("ch_x")], CURSOR_B),
        reset: true,
      });
    const r = createChannelDirectoryReconciler({
      fetchFeed,
      onApply: (rows) => applied.push(rows),
      now: () => NOW,
    });
    await r.reconcile();
    await r.reconcile();
    expect(applied[1].map((x) => x.channelId)).toEqual(["ch_x"]);
    expect(r.status()).toBe("ready");
  });

  it("flags a server-expired cursorExpiresAt as a contract error", async () => {
    const errors: Error[] = [];
    const r = createChannelDirectoryReconciler({
      fetchFeed: async () => ({
        ...snapshotFeed([row("ch_a")]),
        cursorExpiresAt: new Date(NOW - 1000).toISOString(),
      }),
      onApply: () => {},
      onError: (e) => errors.push(e),
      now: () => NOW,
    });
    await expect(r.reconcile()).rejects.toThrow("expired cursor");
    expect(r.status()).toBe("contract_error");
    expect(errors).toHaveLength(1);
  });

  it("coalesces a wake burst into one in-flight run plus one trailing run", async () => {
    let resolveFirst!: (feed: ChannelDirectoryFeed) => void;
    const fetchFeed = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<ChannelDirectoryFeed>((res) => (resolveFirst = res)),
      )
      .mockResolvedValue(deltaFeed([row("ch_late")]));
    const r = createChannelDirectoryReconciler({
      fetchFeed,
      onApply: () => {},
      now: () => NOW,
    });

    const first = r.reconcile("startup");
    // Let the queued microtask start the fetch before the wake burst arrives.
    await Promise.resolve();
    const burst = [
      r.reconcile("wake"),
      r.reconcile("wake"),
      r.reconcile("wake"),
    ];
    resolveFirst(snapshotFeed([row("ch_a")]));
    await Promise.all([first, ...burst]);

    // 1 initial + exactly 1 trailing — never one fetch per wake.
    expect(fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("invalidate() drops a stale in-flight apply and re-runs under the new epoch", async () => {
    const resolvers: Array<(feed: ChannelDirectoryFeed) => void> = [];
    const applied: ChannelDirectoryRow[][] = [];
    const r = createChannelDirectoryReconciler({
      fetchFeed: () => new Promise((res) => resolvers.push(res)),
      onApply: (rows) => applied.push(rows),
      now: () => NOW,
    });
    const run = r.reconcile();
    await vi.waitFor(() => expect(resolvers.length).toBe(1));
    r.invalidate();
    // The stale response arrives under the OLD epoch — its apply is dropped,
    // and the mobile-pattern trailing run re-fetches under the new epoch.
    resolvers[0](snapshotFeed([row("ch_stale")]));
    await vi.waitFor(() => expect(resolvers.length).toBe(2));
    resolvers[1](snapshotFeed([row("ch_fresh")], CURSOR_B));
    await run;
    expect(applied.map((rows) => rows.map((x) => x.channelId))).toEqual([
      ["ch_fresh"],
    ]);
  });

  it("safety refetch: a lost wake self-heals within the bounded interval", async () => {
    vi.useFakeTimers();
    try {
      const applied: ChannelDirectoryRow[][] = [];
      const fetchFeed = vi
        .fn()
        .mockResolvedValueOnce(snapshotFeed([row("ch_a")]))
        // The wake for ch_new was LOST — only the interval pass sees it.
        .mockResolvedValue(
          deltaFeed([
            row("ch_new", { lastActivityAt: "2026-08-13T08:45:00.000Z" }),
          ]),
        );
      const r = createChannelDirectoryReconciler({
        fetchFeed,
        onApply: (rows) => applied.push(rows),
        now: () => NOW,
      });
      await r.reconcile("startup");
      expect(applied[0].map((x) => x.channelId)).toEqual(["ch_a"]);

      r.start();
      await vi.advanceTimersByTimeAsync(CHANNEL_DIRECTORY_SAFETY_REFETCH_MS);

      expect(fetchFeed).toHaveBeenCalledTimes(2);
      expect(applied.at(-1)!.map((x) => x.channelId)).toEqual([
        "ch_new",
        "ch_a",
      ]);
      r.stop();
      // stop() disarms the interval — no further fetches.
      await vi.advanceTimersByTimeAsync(
        CHANNEL_DIRECTORY_SAFETY_REFETCH_MS * 3,
      );
      expect(fetchFeed).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setSafetyPolling(false) disarms the interval without tearing down", async () => {
    vi.useFakeTimers();
    try {
      const fetchFeed = vi.fn().mockResolvedValue(snapshotFeed([row("ch_a")]));
      const r = createChannelDirectoryReconciler({
        fetchFeed,
        onApply: () => {},
        now: () => NOW,
      });
      await r.reconcile("startup");
      r.setSafetyPolling(true);
      r.setSafetyPolling(false);
      await vi.advanceTimersByTimeAsync(
        CHANNEL_DIRECTORY_SAFETY_REFETCH_MS * 2,
      );
      expect(fetchFeed).toHaveBeenCalledTimes(1);
      r.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies failures: auth, offline, retryable", async () => {
    const statuses: string[] = [];
    const make = (rejection: unknown) =>
      createChannelDirectoryReconciler({
        fetchFeed: () => Promise.reject(rejection),
        onApply: () => {},
        onStatus: (s) => statuses.push(s),
        now: () => NOW,
      });

    await expect(
      make("Not signed in: token expired").reconcile(),
    ).rejects.toThrow();
    await expect(make("Network error: dns").reconcile()).rejects.toThrow();
    await expect(
      make(new TypeError("fetch failed")).reconcile(),
    ).rejects.toThrow();
    await expect(
      make("Request failed (status 500)").reconcile(),
    ).rejects.toThrow();

    expect(statuses.filter((s) => s !== "reconciling")).toEqual([
      "auth_blocked",
      "offline",
      "offline",
      "retryable_error",
    ]);
  });

  it("is a no-op after stop()", async () => {
    const fetchFeed = vi.fn();
    const r = createChannelDirectoryReconciler({
      fetchFeed,
      onApply: () => {},
      now: () => NOW,
    });
    r.stop();
    await r.reconcile();
    expect(fetchFeed).not.toHaveBeenCalled();
    expect(r.status()).toBe("idle");
  });
});

describe("sortDirectoryRows", () => {
  it("orders by activity desc with empty channels (null) last", () => {
    const rows = [
      row("ch_empty", { lastActivityAt: null }),
      row("ch_old", { lastActivityAt: "2026-08-01T00:00:00.000Z" }),
      row("ch_new", { lastActivityAt: "2026-08-13T08:59:00.000Z" }),
    ];
    expect(sortDirectoryRows(rows).map((x) => x.channelId)).toEqual([
      "ch_new",
      "ch_old",
      "ch_empty",
    ]);
  });
});
