import { describe, expect, it, vi } from "vitest";

import { buildAtlasGraph } from "./atlas-build.js";
import {
  AtlasLoadError,
  atlasEndpoint,
  consoleAtlasFetcher,
  createAtlasCache,
  vaultAtlasFetcher,
} from "./atlas-cache.js";
import type { AtlasVaultSource } from "../shell/atlas-landing.js";

const UID = "cmp_test";

/** hq-pro `/v1/files/list` pages, in the producer's envelope. */
function listBody(objects: { key: string; lastModified?: string }[], cursor: string | null = null) {
  return {
    prefix: "",
    objects: objects.map((o) => ({ size: 10, lastModified: "2026-09-01T00:00:00.000Z", ...o })),
    cursor,
    truncated: cursor != null,
    computedAt: "2026-10-02T00:00:00.000Z",
  };
}

const VAULT: Record<string, { key: string; lastModified?: string }[]> = {
  "projects/": [
    { key: "projects/alpha/prd.json", lastModified: "2026-09-20T00:00:00.000Z" },
    { key: "projects/alpha/journal/2026-08-01-kickoff.md" },
    { key: "projects/beta/README.md" },
  ],
  "knowledge/": [{ key: "knowledge/brief.md" }, { key: "knowledge/README.md" }],
  "policies/": [{ key: "policies/tenancy.md" }],
  "repos/": [],
  "workers/": [{ key: "workers/reviewer/worker.yaml" }],
  "skills/": [{ key: "skills/search/SKILL.md" }],
  "registry/resources/": [{ key: "registry/resources/repo-hq-desktop-app.yaml" }],
};

const PRD = JSON.stringify({
  metadata: { repoPath: "repos/private/hq-pro", relatedWorkers: ["reviewer"] },
  userStories: [{ id: "US-1", passes: true }],
});

/** Mocked native adapter: paged listing plus presigned reads, no network. */
function mockSource(): AtlasVaultSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listPage(_company, prefix, cursor) {
      calls.push(`${prefix}|${cursor ?? ""}`);
      const rows = VAULT[prefix] ?? [];
      // Projects come back in two pages so the cursor path is exercised.
      if (prefix === "projects/" && !cursor) return listBody(rows.slice(0, 1), "page-2");
      if (prefix === "projects/" && cursor === "page-2") return listBody(rows.slice(1));
      return listBody(rows);
    },
    async readText(_company, key) {
      return key === "projects/alpha/prd.json" ? PRD : null;
    },
  };
}

describe("Atlas native vault path (QA-016)", () => {
  it("builds the graph from the paged vault listing and project PRDs", async () => {
    const source = mockSource();
    const graph = await buildAtlasGraph(source, UID);
    const ids = graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(
      [
        "knowledge:knowledge/brief.md",
        "policy:policies/tenancy.md",
        "project:projects/alpha/",
        "project:projects/beta/",
        "repo:repos/private/hq-desktop-app/",
        "repo:repos/private/hq-pro/",
        "skill:skills/search/",
        "worker:workers/reviewer/",
      ].sort(),
    );
    expect(source.calls).toContain("projects/|page-2");
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "project:projects/alpha/", target: "repo:repos/private/hq-pro/", kind: "uses" },
        { source: "project:projects/alpha/", target: "worker:workers/reviewer/", kind: "assigned" },
      ]),
    );
    // Dated journal names set the project's born date, not the vault mtime.
    const alpha = graph.nodes.find((n) => n.id === "project:projects/alpha/");
    expect(alpha?.created).toBe(Date.parse("2026-08-01T00:00:00.000Z"));
  });

  it("stops reading PRDs once the budget is spent and still returns the listed objects", async () => {
    const source = mockSource();
    let clock = 0;
    const readText = vi.fn(async () => {
      clock += 10_000;
      return PRD;
    });
    const graph = await buildAtlasGraph({ ...source, readText }, UID, { prdBudgetMs: 5_000, now: () => clock });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(graph.nodes.some((n) => n.id === "project:projects/beta/")).toBe(true);
    const none = vi.fn(async () => PRD);
    const skipped = await buildAtlasGraph({ ...source, readText: none }, UID, { prdBudgetMs: 0, now: () => 0 });
    expect(none).not.toHaveBeenCalled();
    expect(skipped.nodes.some((n) => n.id === "project:projects/alpha/")).toBe(true);
    expect(skipped.edges?.some((e) => e.source === "project:projects/alpha/")).toBe(false);
  });

  it("refreshes through the adapter, caches the snapshot, and never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const cache = createAtlasCache({ fetcher: vaultAtlasFetcher(mockSource()), storage });
    expect(cache.cached(UID)).toBeNull();
    const graph = await cache.refresh(UID);
    expect(graph?.nodes.length).toBe(8);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    // A new session paints the stored snapshot before any refresh.
    const next = createAtlasCache({ fetcher: async () => new Promise(() => undefined), storage });
    expect(next.cached(UID)?.nodes.length).toBe(8);
  });

  it("an adapter auth failure surfaces as signed-out", async () => {
    const source: AtlasVaultSource = {
      listPage: async () => {
        throw new Error("vault list http-401");
      },
      readText: async () => null,
    };
    const cache = createAtlasCache({ fetcher: vaultAtlasFetcher(source) });
    await expect(cache.refresh(UID)).rejects.toMatchObject({ reason: "signed-out" });
  });

  it("an adapter access failure surfaces as no-access", async () => {
    const source: AtlasVaultSource = {
      listPage: async () => {
        throw new Error("vault list http-403");
      },
      readText: async () => null,
    };
    await expect(vaultAtlasFetcher(source)(UID)).rejects.toBeInstanceOf(AtlasLoadError);
    await expect(vaultAtlasFetcher(source)(UID)).rejects.toMatchObject({ reason: "no-access" });
  });
});

describe("Atlas web session path", () => {
  it("fetches the Console endpoint with the browser session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ company: UID, nodes: [] }), { status: 200 }));
    await consoleAtlasFetcher("https://console.test", fetchImpl as unknown as typeof fetch)(UID);
    expect(fetchImpl).toHaveBeenCalledWith(
      atlasEndpoint("https://console.test", UID),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("a 401 from the Console endpoint surfaces as signed-out", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      consoleAtlasFetcher("https://console.test", fetchImpl as unknown as typeof fetch)(UID),
    ).rejects.toMatchObject({ reason: "signed-out" });
  });
});
