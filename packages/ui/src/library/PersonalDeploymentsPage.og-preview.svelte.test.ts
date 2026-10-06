// @vitest-environment happy-dom

// Owner ask: "can we add a og image + site preview to sidepane too (maybe they
// only generate when you click on the row then store locally)". The side panel
// shows the selected app's og:image, read lazily for that row only.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import PersonalDeploymentsPage, { resetDeployPillsForTests } from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";
import { resetDeployPreviewCacheForTests, type DeployPreviewFetcher } from "./deploy-preview.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  resetDeployPillsForTests();
  resetDeployPreviewCacheForTests();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

const THUMB = "data:image/png;base64,AA==";

async function mountPage(deployAppPreview: DeployPreviewFetcher, opened: string[] = [], listDeployApps?: (scope: string) => Promise<unknown>): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: "og-preview",
      companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
      listDeployApps: listDeployApps ?? (async (scope: string) => ({ ok: true, value: deployAppsFixture(scope) as never })),
      deployAppPreview,
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
});
