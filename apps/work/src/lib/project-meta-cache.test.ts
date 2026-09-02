import { describe, expect, it, vi } from "vitest";
import {
  createChatWakeBus,
  type ConversationRow,
} from "@hq/ui";
import type { LiveProjectMeta, LiveProjectMetaLoad } from "./live-project.js";
import {
  createProjectMetaCache,
  PROJECT_META_FRESHNESS_MS,
  subscribeProjectMetaInvalidations,
} from "./project-meta-cache.js";

const row: ConversationRow = {
  id: "ch:chn_atlas",
  kind: "channel",
  title: "Atlas",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_atlas",
  channelScope: "project",
  projectId: "atlas",
};

const firstMeta = {
  board: null,
  files: [],
  status: null,
} as LiveProjectMeta;

const secondMeta = {
  board: null,
  files: [],
  status: null,
} as LiveProjectMeta;

const loaded = (meta: LiveProjectMeta): LiveProjectMetaLoad => ({
  meta,
  definitiveMiss: false,
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project metadata cache", () => {
  it("refetches after a channel update wake instead of returning its memoized metadata", async () => {
    const load = vi.fn(async () => loaded(firstMeta));
    const cache = createProjectMetaCache({ load });
    const wakes = createChatWakeBus();
    const unsubscribe = subscribeProjectMetaInvalidations(wakes, cache);

    expect(cache.read(row)).toBeNull();
    await settle();
    expect(cache.read(row)).toBe(firstMeta);

    wakes.emit("channel:updated", {
      channelId: "chn_atlas",
      name: "Atlas",
      scope: "project",
    });

    expect(cache.read(row)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("does not refetch project metadata for an unrelated message wake", async () => {
    const load = vi.fn(async () => loaded(firstMeta));
    const cache = createProjectMetaCache({ load });
    const wakes = createChatWakeBus();
    const unsubscribe = subscribeProjectMetaInvalidations(wakes, cache);

    cache.read(row);
    await settle();
    wakes.emit("channel:new-message", { channelId: "chn_atlas" });

    expect(cache.read(row)).toBe(firstMeta);
    expect(load).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("refetches lazily after the bounded metadata freshness window", async () => {
    let now = 1_000;
    const load = vi.fn(async () => loaded(firstMeta));
    const cache = createProjectMetaCache({ load, now: () => now });

    cache.read(row);
    await settle();
    now += PROJECT_META_FRESHNESS_MS + 1;

    expect(cache.read(row)).toBeNull();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let a response from before invalidation overwrite a newer load", async () => {
    const stale = deferred<LiveProjectMetaLoad>();
    const fresh = deferred<LiveProjectMetaLoad>();
    const load = vi
      .fn<() => Promise<LiveProjectMetaLoad>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);
    const cache = createProjectMetaCache({ load });
    const wakes = createChatWakeBus();
    const unsubscribe = subscribeProjectMetaInvalidations(wakes, cache);

    cache.read(row);
    wakes.emit("channel:updated", {
      channelId: "chn_atlas",
      name: "Atlas",
      scope: "project",
    });
    cache.read(row);

    fresh.resolve(loaded(secondMeta));
    await settle();
    stale.resolve(loaded(firstMeta));
    await settle();

    expect(cache.read(row)).toBe(secondMeta);
    unsubscribe();
  });

  it("clears a definite miss when the matching channel changes", async () => {
    const load = vi
      .fn<() => Promise<LiveProjectMetaLoad>>()
      .mockResolvedValueOnce({ meta: null, definitiveMiss: true })
      .mockResolvedValueOnce(loaded(secondMeta));
    const cache = createProjectMetaCache({ load });
    const wakes = createChatWakeBus();
    const unsubscribe = subscribeProjectMetaInvalidations(wakes, cache);

    cache.read(row);
    await settle();
    expect(cache.read(row)).toBeNull();

    wakes.emit("channel:updated", {
      channelId: "chn_atlas",
      name: "Atlas",
      scope: "project",
    });
    cache.read(row);
    await settle();

    expect(cache.read(row)).toBe(secondMeta);
    expect(load).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("memoizes an inconclusive result before notifying reactive readers", async () => {
    const load = vi.fn(async (): Promise<LiveProjectMetaLoad> => ({
      meta: null,
      definitiveMiss: false,
    }));
    let reruns = 0;
    let cache!: ReturnType<typeof createProjectMetaCache>;
    cache = createProjectMetaCache({
      load,
      onChanged: () => {
        reruns += 1;
        // Simulate a derived consumer re-reading metadata after the cache
        // publishes a completed load. Stop after three turns so a broken
        // cache fails its bounded-load assertion instead of spinning forever.
        if (reruns < 3) cache.read(row);
      },
    });

    expect(cache.read(row)).toBeNull();
    await settle();
    await settle();
    await settle();

    expect(reruns).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
