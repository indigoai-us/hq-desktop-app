import { describe, expect, it, vi } from "vitest";
import { AtlasLoadError, createAtlasCache } from "./atlas-cache.js";
import { smokeAtlasGraph } from "./atlas-model.js";

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("createAtlasCache with a first page (QA-016 re-test)", () => {
  it("applies the refresh timeout to the first page only", async () => {
    const full = smokeAtlasGraph();
    const first = { ...full, nodes: full.nodes.slice(0, 2), edges: [] };
    const storage = new Map<string, string>();
    const cache = createAtlasCache({
      fetcher: { first: async () => first, full: () => later(80, full) },
      storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v) },
      timeoutMs: 20,
      fullTimeoutMs: 1_000,
    });
    const partials: number[] = [];
    const graph = await cache.refresh("co", (g) => partials.push(g.nodes.length));
    expect(partials).toEqual([2]);
    expect(graph?.nodes.length).toBe(full.nodes.length);
    // Only the full graph is saved for the next open.
    expect(JSON.parse(storage.get("hq.atlas.v1:co")!).nodes.length).toBe(full.nodes.length);
  });

  it("fails with a timeout when the first page itself is slow", async () => {
    const full = vi.fn(async () => smokeAtlasGraph());
    const cache = createAtlasCache({
      fetcher: { first: () => later(100, smokeAtlasGraph()), full },
      timeoutMs: 20,
    });
    await expect(cache.refresh("co")).rejects.toMatchObject({ reason: "timeout" });
    expect(full).not.toHaveBeenCalled();
  });

  it("runs the full load under the first-page timeout when there is no first page", async () => {
    const cache = createAtlasCache({
      fetcher: { first: async () => null, full: () => later(100, smokeAtlasGraph()) },
      timeoutMs: 20,
      fullTimeoutMs: 1_000,
    });
    const err = await cache.refresh("co").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AtlasLoadError);
  });

  it("hands the partial map to a second caller that joins mid-load", async () => {
    const full = smokeAtlasGraph();
    const first = { ...full, nodes: full.nodes.slice(0, 1), edges: [] };
    const cache = createAtlasCache({ fetcher: { first: async () => first, full: () => later(30, full) } });
    const a = cache.refresh("co");
    await later(5, null);
    const seen: number[] = [];
    const b = cache.refresh("co", (g) => seen.push(g.nodes.length));
    expect(seen).toEqual([1]);
    expect(await a).toBe(await b);
  });
});
