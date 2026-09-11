/**
 * Regression: the rail cache must never truncate a live channel just because
 * the server listed it late.
 *
 * `GET /v1/notify/channels` returns the caller's channels in ARBITRARY order —
 * it is not sorted by `lastActivityAt`. The cache cap used to be
 * `rows.slice(0, MAX_DIRECTORY_ROWS)`, so on a large account it dropped
 * whatever the server happened to emit past the budget. On the reporting
 * account the Indigo company channel `#hq-dev` (`chn_01KWGKH0H5C8D8YC7XWZTQPTX6`)
 * arrived at index 836 of 848 while holding the single NEWEST message of any
 * channel, so it was cut — and because this cache is the ⌘K / search index, the
 * first-paint seed and the degraded fallback, the channel vanished from the
 * sidebar, from search and from the command palette at the same time.
 *
 * The fixture below is shaped like that real payload: unsorted, over budget,
 * with the newest channel near the end.
 */

import { describe, expect, it } from "vitest";

import type { ChannelDirectoryRow } from "@hq/ui";

import {
  EMPTY_SHALLOW_CACHE,
  MAX_DIRECTORY_ROWS,
  mergeShallowCache,
  readShallowCache,
  writeShallowCache,
} from "./browser-cache.js";

/** The real row that went missing (ids only — no message bodies). */
const HQ_DEV: ChannelDirectoryRow = {
  channelId: "chn_01KWGKH0H5C8D8YC7XWZTQPTX6",
  type: "chat",
  scope: "company",
  companyUid: "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG",
  projectId: null,
  name: "hq-dev",
  subtitle: "Company channel",
  lastActivityAt: "2026-09-04T19:45:56.995Z",
  createdAt: "2026-07-02T05:06:19.303Z",
  updatedAt: "2026-09-04T19:45:57.001Z",
  unreadCount: 0,
  memberCount: 8,
};

/**
 * 848 rows in arbitrary server order with `#hq-dev` at index 836, mirroring the
 * captured production payload. Every filler row is older than `#hq-dev`.
 */
function realShapedDirectory(): ChannelDirectoryRow[] {
  const rows: ChannelDirectoryRow[] = [];
  for (let i = 0; i < 848; i += 1) {
    if (i === 836) {
      rows.push(HQ_DEV);
      continue;
    }
    // Deliberately NOT monotonic in activity — the server does not sort.
    const day = 1 + (i % 27);
    rows.push({
      channelId: `chn_filler_${String(i).padStart(4, "0")}`,
      type: "project",
      scope: "project",
      companyUid: "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG",
      projectId: `filler-${i}`,
      name: `Project filler-${i}`,
      // Roughly a third carry no activity at all, like the real payload.
      lastActivityAt:
        i % 3 === 0
          ? null
          : `2026-08-${String(day).padStart(2, "0")}T04:00:00.000Z`,
      unreadCount: 0,
    });
  }
  return rows;
}

describe("shallow cache directory cap", () => {
  it("keeps the newest channel even when the server lists it past the cap", () => {
    const rows = realShapedDirectory();
    expect(rows).toHaveLength(848);
    expect(rows.length).toBeGreaterThan(MAX_DIRECTORY_ROWS);
    expect(rows.indexOf(HQ_DEV)).toBe(836);

    const cached = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      { directory: rows },
      "prs_owner",
      5_000,
    );

    expect(cached.directory).toHaveLength(MAX_DIRECTORY_ROWS);
    expect(
      cached.directory.map((row) => row.channelId),
    ).toContain(HQ_DEV.channelId);
  });

  it("survives the localStorage round-trip that feeds ⌘K and search", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    };
    const cached = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      { directory: realShapedDirectory() },
      "prs_owner",
      5_000,
    );
    writeShallowCache(cached, storage);

    const read = readShallowCache("prs_owner", storage, 6_000);
    expect(read.directory).toHaveLength(MAX_DIRECTORY_ROWS);
    const hit = read.directory.find(
      (row) => row.channelId === HQ_DEV.channelId,
    );
    expect(hit?.name).toBe("hq-dev");
    // Its activity stamp must survive too — the sidebar buckets TODAY off it.
    expect(hit?.lastActivityAt).toBe("2026-09-04T19:45:56.995Z");
  });

  it("drops the least recently active rows, not arbitrary ones", () => {
    // One row over budget: the single oldest/empty row is the one that goes.
    const rows: ChannelDirectoryRow[] = Array.from(
      { length: MAX_DIRECTORY_ROWS },
      (_, i) => ({
        channelId: `chn_keep_${i}`,
        scope: "project",
        name: `Keep ${i}`,
        lastActivityAt: `2026-09-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
        unreadCount: 0,
      }),
    );
    rows.push({
      channelId: "chn_stale",
      scope: "project",
      name: "Stale",
      lastActivityAt: null,
      unreadCount: 0,
    });

    const cached = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      { directory: rows },
      "prs_owner",
      5_000,
    );
    const ids = cached.directory.map((row) => row.channelId);
    expect(ids).toHaveLength(MAX_DIRECTORY_ROWS);
    expect(ids).not.toContain("chn_stale");
  });

  it("never evicts an unread channel", () => {
    const rows: ChannelDirectoryRow[] = Array.from(
      { length: MAX_DIRECTORY_ROWS + 5 },
      (_, i) => ({
        channelId: `chn_busy_${i}`,
        scope: "project",
        name: `Busy ${i}`,
        lastActivityAt: `2026-09-02T00:00:00.000Z`,
        unreadCount: 0,
      }),
    );
    rows.push({
      channelId: "chn_unread_last",
      scope: "company",
      name: "hq-dev",
      // No activity stamp at all, listed dead last, but it has unread.
      lastActivityAt: null,
      unreadCount: 3,
    });

    const cached = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      { directory: rows },
      "prs_owner",
      5_000,
    );
    expect(cached.directory.map((row) => row.channelId)).toContain(
      "chn_unread_last",
    );
  });
});
