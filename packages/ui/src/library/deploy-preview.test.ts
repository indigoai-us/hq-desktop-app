import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedDeployPreview,
  loadDeployPreview,
  previewable,
  previewCacheKey,
  resetDeployPreviewCacheForTests,
  cachedPanelPreview,
  loadPanelPreview,
  resetPanelPreviewCacheForTests,
  snapshotEligible,
  type DeployPreviewFetcher,
  type DeploySnapshotFetcher,
} from "./deploy-preview.js";
import { deploymentFromApp, sortDeployments, readDeploySort, writeDeploySort, nextDeploySort, type PersonalDeployment } from "./personal-deployments.js";

afterEach(() => {
  resetDeployPreviewCacheForTests();
  resetPanelPreviewCacheForTests();
  localStorage.clear();
});

function row(overrides: Partial<PersonalDeployment> = {}): PersonalDeployment {
  const base = deploymentFromApp(
    { id: "a1", name: "demo", subdomain: "demo", url: "https://demo.indigo-hq.com", status: "active", active: true, deployedAt: "2026-10-01T00:00:00Z" },
    { id: "personal", label: "Personal" },
    null,
  )!;
  return { ...base, ...overrides };
}

const ok = (value: unknown) => Promise.resolve({ ok: true as const, value: value as never });

describe("deploy preview cache", () => {
  it("keys on app id and deploy time, so a redeploy misses the old entry", () => {
    expect(previewCacheKey(row())).toBe("personal:a1|2026-10-01T00:00:00Z");
    expect(previewCacheKey(row({ deployedAt: "2026-10-05T00:00:00Z" }))).not.toBe(previewCacheKey(row()));
  });

  it("previews only live https deployments", () => {
    expect(previewable(row())).toBe(true);
    expect(previewable(row({ status: "sleeping" }))).toBe(false);
    expect(previewable(row({ url: "" }))).toBe(false);
    expect(previewable(null)).toBe(false);
  });

  it("reads once per key, shares the in-flight read, and serves the memory copy after", async () => {
    const fetcher = vi.fn<DeployPreviewFetcher>(() => ok({ ogImageUrl: "https://demo.indigo-hq.com/og.png", thumbnail: "data:image/png;base64,AA==" }));
    const [a, b] = await Promise.all([loadDeployPreview(fetcher, row()), loadDeployPreview(fetcher, row())]);
    expect(a).toEqual(b);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("personal:a1", "https://demo.indigo-hq.com", "2026-10-01T00:00:00Z", false);
    expect(cachedDeployPreview(row())?.thumbnail).toBe("data:image/png;base64,AA==");
    await loadDeployPreview(fetcher, row());
    expect(fetcher).toHaveBeenCalledTimes(1);
    await loadDeployPreview(fetcher, row({ deployedAt: "2026-10-05T00:00:00Z" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await loadDeployPreview(fetcher, row(), { refresh: true });
    expect(fetcher).toHaveBeenLastCalledWith("personal:a1", "https://demo.indigo-hq.com", "2026-10-01T00:00:00Z", true);
  });

  it("drops non-image thumbnails and rejects a failed read without caching it", async () => {
    const odd = await loadDeployPreview(() => ok({ ogImageUrl: "", thumbnail: "javascript:alert(1)" }), row());
    expect(odd).toEqual({ ogImageUrl: null, thumbnail: null });
    resetDeployPreviewCacheForTests();
    await expect(loadDeployPreview(() => Promise.resolve({ ok: false as const, reason: "error" }), row())).rejects.toThrow();
    expect(cachedDeployPreview(row())).toBeNull();
  });
});

describe("deploy sort", () => {
  const rows = [
    row({ id: "old", name: "b", deployedAt: "2026-09-01T00:00:00Z" }),
    row({ id: "none", name: "c", deployedAt: undefined }),
    row({ id: "new", name: "a", deployedAt: "2026-10-04T00:00:00Z" }),
  ];

  it("defaults to newest deploy first with missing times last in both directions", () => {
    expect(sortDeployments(rows, null).map((r) => r.id)).toEqual(["new", "old", "none"]);
    expect(sortDeployments(rows, { key: "deployed", direction: "ascending" }).map((r) => r.id)).toEqual(["old", "new", "none"]);
  });

  it("flips the active column and opens a new column in its initial direction", () => {
    expect(nextDeploySort({ key: "deployed", direction: "descending" }, "deployed")).toEqual({ key: "deployed", direction: "ascending" });
    expect(nextDeploySort({ key: "deployed", direction: "descending" }, "app")).toEqual({ key: "app", direction: "ascending" });
    expect(nextDeploySort({ key: "app", direction: "ascending" }, "views")).toEqual({ key: "views", direction: "descending" });
  });

  it("persists per account and ignores unreadable stored values", () => {
    expect(readDeploySort("u1")).toEqual({ key: "deployed", direction: "descending" });
    writeDeploySort("u1", { key: "app", direction: "descending" });
    expect(readDeploySort("u1")).toEqual({ key: "app", direction: "descending" });
    expect(readDeploySort("u2")).toEqual({ key: "deployed", direction: "descending" });
    localStorage.setItem("hq.personal-deployments.sort.v1:u3", JSON.stringify({ key: "nope", direction: "up" }));
    expect(readDeploySort("u3")).toEqual({ key: "deployed", direction: "descending" });
  });
});

describe("side-panel preview order", () => {
  const SNAP = "data:image/png;base64,SNAP";
  const OG = "data:image/png;base64,OG";
  const publicRow = () => row({ access: "Public" });
  const og = () => vi.fn<DeployPreviewFetcher>(() => ok({ ogImageUrl: "https://x/og.png", thumbnail: OG }));

  it("uses the rendered snapshot for a public app and skips the share image", async () => {
    const snapshot = vi.fn<DeploySnapshotFetcher>(() => ok({ snapshot: SNAP, width: 2560, height: 1600 }));
    const share = og();
    expect(await loadPanelPreview({ snapshot, og: share }, publicRow())).toEqual({ kind: "snapshot", src: SNAP });
    expect(share).not.toHaveBeenCalled();
    expect(cachedPanelPreview(publicRow())?.kind).toBe("snapshot");
  });

  it("falls back to the share image when the snapshot fails", async () => {
    const snapshot = vi.fn<DeploySnapshotFetcher>(() => Promise.resolve({ ok: false as const, reason: "error", message: "snapshot: not supported" } as never));
    expect(await loadPanelPreview({ snapshot, og: og() }, publicRow())).toEqual({ kind: "og", src: OG });
  });

  it("falls back to the share image when the snapshot times out", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = vi.fn<DeploySnapshotFetcher>(() => new Promise(() => undefined));
      const pending = loadPanelPreview({ snapshot, og: og() }, publicRow(), { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toEqual({ kind: "og", src: OG });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never renders protected apps; they go straight to the share image", async () => {
    const snapshot = vi.fn<DeploySnapshotFetcher>(() => ok({ snapshot: SNAP }));
    for (const access of ["Password", "Company", "Invited only", "Selected people"]) {
      resetPanelPreviewCacheForTests();
      expect(snapshotEligible(row({ access }))).toBe(false);
      expect((await loadPanelPreview({ snapshot, og: og() }, row({ access }))).kind).toBe("og");
    }
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("shows nothing when there is no snapshot and no share image, and rejects when every source failed", async () => {
    const none = vi.fn<DeployPreviewFetcher>(() => ok({ ogImageUrl: null, thumbnail: null }));
    expect(await loadPanelPreview({ og: none }, publicRow())).toEqual({ kind: "none", src: null });
    resetPanelPreviewCacheForTests();
    const broken = vi.fn<DeploySnapshotFetcher>(() => Promise.reject(new Error("ipc")));
    const ogBroken = vi.fn<DeployPreviewFetcher>(() => Promise.resolve({ ok: false as const, reason: "error", message: "502" } as never));
    await expect(loadPanelPreview({ snapshot: broken, og: ogBroken }, publicRow())).rejects.toThrow();
    expect(cachedPanelPreview(publicRow())).toBeNull();
  });

  it("refresh bypasses the memory copy and asks the desktop to re-render", async () => {
    const snapshot = vi.fn<DeploySnapshotFetcher>(() => ok({ snapshot: SNAP }));
    await loadPanelPreview({ snapshot }, publicRow());
    await loadPanelPreview({ snapshot }, publicRow());
    expect(snapshot).toHaveBeenCalledTimes(1);
    await loadPanelPreview({ snapshot }, publicRow(), { refresh: true });
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(snapshot.mock.calls[1]?.[3]).toBe(true);
  });
});
