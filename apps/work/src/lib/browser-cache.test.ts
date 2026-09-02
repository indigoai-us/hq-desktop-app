import { describe, expect, it } from "vitest";

import {
  EMPTY_SHALLOW_CACHE,
  MAX_CACHED_BODY_CHARS,
  MAX_DIRECTORY_ROWS,
  MAX_THREAD_MESSAGES,
  SHALLOW_CACHE_TTL_MS,
  isShallowCacheFresh,
  mergeShallowCache,
  persistLastSelected,
  persistLastThread,
  pickMostRecentDirectoryRow,
  readShallowCache,
  resolveLastSelectedId,
  writeShallowCache,
} from "./browser-cache.js";

function memoryStorage(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe("shallow browser cache", () => {
  it("rejects another person's blob and expired rows", () => {
    const cache = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      {
        directory: [
          { channelId: "a", scope: "project", name: "A", lastActivityAt: null },
        ],
      },
      "prs_me",
      1_000,
    );
    expect(isShallowCacheFresh(cache, "prs_other", 1_000)).toBe(false);
    expect(
      isShallowCacheFresh(cache, "prs_me", 1_000 + SHALLOW_CACHE_TTL_MS + 1),
    ).toBe(false);
    expect(isShallowCacheFresh(cache, "prs_me", 1_000 + 60_000)).toBe(true);
  });

  it("round-trips through storage and caps directory size", () => {
    const storage = memoryStorage();
    const rows = Array.from({ length: MAX_DIRECTORY_ROWS + 20 }, (_, i) => ({
      channelId: `ch-${i}`,
      scope: "project",
      name: `C${i}`,
      lastActivityAt: null,
    }));
    const written = mergeShallowCache(
      EMPTY_SHALLOW_CACHE,
      { directory: rows },
      "prs_me",
      5_000,
    );
    expect(written.directory).toHaveLength(MAX_DIRECTORY_ROWS);
    writeShallowCache(written, storage);
    const read = readShallowCache("prs_me", storage, 6_000);
    expect(read.directory).toHaveLength(MAX_DIRECTORY_ROWS);
    expect(read.directory[0]?.channelId).toBe("ch-0");
  });

  it("persists the last open thread and caps message count", () => {
    const storage = memoryStorage();
    const messages = Array.from(
      { length: MAX_THREAD_MESSAGES + 8 },
      (_, i) => ({
        eventId: `e-${i}`,
        body: `m${i}`,
      }),
    );
    persistLastThread("prs_me", "ch:alpha", messages as never, storage);
    const read = readShallowCache("prs_me", storage);
    expect(read.lastThread?.key).toBe("ch:alpha");
    expect(read.lastThread?.messages).toHaveLength(MAX_THREAD_MESSAGES);
    expect(read.lastThread?.messages[0]?.eventId).toBe("e-8");
    expect(read.lastSelectedId).toBe("ch:alpha");
  });

  it("truncates huge thread bodies so localStorage writes stay small", () => {
    const storage = memoryStorage();
    persistLastThread(
      "prs_me",
      "dm:agt_deacon",
      [
        {
          eventId: "e-big",
          body: "x".repeat(MAX_CACHED_BODY_CHARS + 2000),
        },
      ] as never,
      storage,
    );
    const read = readShallowCache("prs_me", storage);
    const body = read.lastThread?.messages[0]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(MAX_CACHED_BODY_CHARS + 2);
    expect(body.endsWith("…")).toBe(true);
  });

  it("restores an explicit last-selected id over directory order", () => {
    const storage = memoryStorage();
    persistLastSelected("prs_me", "ch:later", storage);
    const read = readShallowCache("prs_me", storage);
    expect(resolveLastSelectedId(read)).toBe("ch:later");
  });

  it("picks the directory row with the newest lastActivityAt", () => {
    const recent = pickMostRecentDirectoryRow([
      {
        channelId: "old",
        scope: "project",
        name: "Old",
        lastActivityAt: "2026-01-01T00:00:00.000Z",
      },
      {
        channelId: "new",
        scope: "project",
        name: "New",
        lastActivityAt: "2026-08-17T18:00:00.000Z",
      },
    ]);
    expect(recent?.channelId).toBe("new");
  });
});
