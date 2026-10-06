// @vitest-environment happy-dom

// Owner ask: "can we add a og image + site preview to sidepane too (maybe they
// only generate when you click on the row then store locally)". The side panel
// shows the selected app's og:image, read lazily for that row only.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import PersonalDeploymentsPage, { resetDeployPillsForTests } from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";
import { PREVIEW_DEBOUNCE_MS, resetPanelPreviewCacheForTests, type DeployPreviewFetcher, type DeploySnapshotFetcher } from "./deploy-preview.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  resetDeployPillsForTests();
  resetPanelPreviewCacheForTests();
});

/** Past the selection debounce, so the preview read has started. */
async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, PREVIEW_DEBOUNCE_MS + 30));
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

const THUMB = "data:image/png;base64,AA==";

async function mountPage(
  deployAppPreview: DeployPreviewFetcher,
  opened: string[] = [],
  listDeployApps?: (scope: string) => Promise<unknown>,
  deployAppSnapshot?: DeploySnapshotFetcher,
): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: "og-preview",
      companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
      listDeployApps: listDeployApps ?? (async (scope: string) => ({ ok: true, value: deployAppsFixture(scope) as never })),
      deployAppPreview,
      deployAppSnapshot,
      openExternal: (url: string) => opened.push(url),
    } as never,
  });
  await settle();
  return host;
}

async function choose(root: HTMLElement, name: string): Promise<void> {
  [...root.querySelectorAll<HTMLElement>(".table .drow:not(.hd)")].find((el) => el.textContent?.includes(name))!.click();
  await settle();
}

describe("Deployments side-panel og:image preview", () => {
  it("reads only the selected row, shows the image, and opens the site through the host opener", async () => {
    const opened: string[] = [];
    const fetcher = vi.fn<DeployPreviewFetcher>(async () => ({ ok: true, value: { ogImageUrl: "https://x/og.png", thumbnail: THUMB } as never }));
    const root = await mountPage(fetcher, opened);
    await choose(root, "indigo-standup-report");
    // The first row (auto-selected) plus the clicked one; never the whole list.
    expect(fetcher.mock.calls.map((call) => call[1])).toEqual([
      "https://hq-desktop-console-rail-storyboard.indigo-hq.com",
      "https://indigo-standup-report.indigo-hq.com",
    ]);
    const og = root.querySelector<HTMLButtonElement>("[data-testid='deploy-og']")!;
    expect(og.querySelector("img")?.getAttribute("src")).toBe(THUMB);
    expect(root.querySelector("iframe")).toBeNull();
    og.click();
    expect(opened).toEqual(["https://indigo-standup-report.indigo-hq.com"]);
    // Reselecting a row paints from the cache with no second read.
    await choose(root, "hq-desktop-console-rail-storyboard");
    await choose(root, "indigo-standup-report");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[data-testid='deploy-og-loading']")).toBeNull();
  });

  it("shows nothing when the page has no og:image and no read for non-live rows", async () => {
    const fetcher = vi.fn<DeployPreviewFetcher>(async () => ({ ok: true, value: { ogImageUrl: null, thumbnail: null } as never }));
    const root = await mountPage(fetcher);
    await choose(root, "indigo-standup-report");
    const inspector = root.querySelector("[data-testid='deploy-inspector']")!;
    expect(inspector.querySelector("[data-testid^='deploy-og']")).toBeNull();
    expect(inspector.querySelector("img")).toBeNull();
    const calls = fetcher.mock.calls.length;
    await choose(root, "telemetry-sep-export");
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });

  it("holds a skeleton while slow, then shows a quiet failure with a working retry", async () => {
    let fail = true;
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const fetcher = vi.fn<DeployPreviewFetcher>(async () => {
      await gate;
      return fail ? { ok: false, reason: "error", message: "HTTP 502 Bad Gateway" } as never : { ok: true, value: { ogImageUrl: "https://x/og.png", thumbnail: THUMB } as never };
    });
    const root = await mountPage(fetcher);
    expect(root.querySelector("[data-testid='deploy-og-loading']")).not.toBeNull();
    release();
    await settle();
    const failed = root.querySelector("[data-testid='deploy-og-failed']")!;
    expect(failed.textContent).toContain("Preview unavailable");
    expect(failed.textContent).not.toContain("502");
    fail = false;
    root.querySelector<HTMLButtonElement>("[data-testid='deploy-og-retry']")!.click();
    await settle();
    expect(fetcher.mock.calls.at(-1)?.[3]).toBe(true);
    expect(root.querySelector("[data-testid='deploy-og'] img")?.getAttribute("src")).toBe(THUMB);
  });

  it("shows a failed company as a banner with a Retry that reloads", async () => {
    let calls = 0;
    const list = async (scope: string) => {
      calls += 1;
      if (scope === "indigo" && calls <= 2) throw new Error("offline");
      return { ok: true, value: deployAppsFixture(scope) as never };
    };
    const root = await mountPage(async () => ({ ok: true, value: {} as never }), [], list);
    const banner = root.querySelector("[data-testid='deploy-failed-scopes']")!;
    expect(banner.textContent).toContain("Couldn't load Indigo right now. Showing the rest.");
    root.querySelector<HTMLButtonElement>("[data-testid='deploy-failed-scopes-retry']")!.click();
    await settle();
    expect(root.querySelector("[data-testid='deploy-failed-scopes']")).toBeNull();
  });

  // Owner: "what about an actual preview of what is on the page? that would be
  // better than og". Public apps show a rendered snapshot of the page.
  const SNAP = "data:image/png;base64,SNAP";
  const withPublicApp = async (scope: string) => {
    const value = deployAppsFixture(scope) as { apps: Record<string, unknown>[] };
    if (scope === "personal") {
      value.apps = [
        { id: "pub", name: "launch-notes", subdomain: "launch-notes", url: "https://launch-notes.indigo-hq.com", status: "active", active: true, accessMode: "public", createdAt: new Date().toISOString() },
        ...value.apps,
      ];
    }
    return { ok: true, value: value as never };
  };

  it("shows the rendered page for a public app, with Refresh preview and click-to-open", async () => {
    const opened: string[] = [];
    const og = vi.fn<DeployPreviewFetcher>(async () => ({ ok: true, value: { ogImageUrl: "https://x/og.png", thumbnail: THUMB } as never }));
    const snapshot = vi.fn<DeploySnapshotFetcher>(async () => ({ ok: true, value: { snapshot: SNAP, width: 2560, height: 1600 } as never }));
    const root = await mountPage(og, opened, withPublicApp, snapshot);
    await choose(root, "launch-notes");
    const snap = root.querySelector<HTMLButtonElement>("[data-testid='deploy-snapshot']")!;
    expect(snap.querySelector("img")?.getAttribute("src")).toBe(SNAP);
    expect(snapshot.mock.calls.map((call) => call[1])).toEqual(["https://launch-notes.indigo-hq.com"]);
    snap.click();
    expect(opened).toEqual(["https://launch-notes.indigo-hq.com"]);
    root.querySelector<HTMLButtonElement>("[data-testid='deploy-preview-refresh']")!.click();
    await settle();
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(snapshot.mock.calls[1]?.[3]).toBe(true);
    // Protected apps never get a hidden-window render; they use the share image.
    await choose(root, "indigo-standup-report");
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(root.querySelector("[data-testid='deploy-og'] img")?.getAttribute("src")).toBe(THUMB);
  });

  it("falls back to the share image when the snapshot fails, without raw errors", async () => {
    const og = vi.fn<DeployPreviewFetcher>(async () => ({ ok: true, value: { ogImageUrl: "https://x/og.png", thumbnail: THUMB } as never }));
    const snapshot = vi.fn<DeploySnapshotFetcher>(async () => ({ ok: false, reason: "error", message: "snapshot: timed out" } as never));
    const root = await mountPage(og, [], withPublicApp, snapshot);
    await choose(root, "launch-notes");
    expect(root.querySelector("[data-testid='deploy-og'] img")?.getAttribute("src")).toBe(THUMB);
    expect(root.querySelector("[data-testid='deploy-inspector']")!.textContent).not.toContain("timed out");
  });

  it("reads only the row the selection stops on when moving quickly", async () => {
    const og = vi.fn<DeployPreviewFetcher>(async () => ({ ok: true, value: { ogImageUrl: null, thumbnail: null } as never }));
    const root = await mountPage(og);
    const calls = og.mock.calls.length;
    for (const name of ["indigo-standup-report", "cut30-week-41", "hq-desktop-console-rail-storyboard", "indigo-standup-report"]) {
      [...root.querySelectorAll<HTMLElement>(".table .drow:not(.hd)")].find((el) => el.textContent?.includes(name))!.click();
      flushSync();
    }
    expect(root.querySelector("[data-testid='deploy-og-loading']")).not.toBeNull();
    await settle();
    expect(og.mock.calls.slice(calls).map((call) => call[1])).toEqual(["https://indigo-standup-report.indigo-hq.com"]);
  });
});
