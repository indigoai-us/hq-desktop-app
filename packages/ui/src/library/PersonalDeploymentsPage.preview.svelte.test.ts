// @vitest-environment happy-dom

// Owner ask: "can we render a preview card in sidepage?" The Deployments
// inspector shows a scaled preview of the selected Live deployment.
//
// Owner report (2026-10-05): "when i open the deployments tab, the first site
// opens in browser. this should not happen". The first row is selected on open,
// and in the desktop shell an iframe navigation is handed to the system browser.
// The live preview is therefore opt-in (`livePreview`), off by default.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import PersonalDeploymentsPage, { resetDeployPillsForTests } from "./PersonalDeploymentsPage.svelte";
import { deployAppsFixture } from "./personal-deployments.fixture.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  resetDeployPillsForTests();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

async function mountPage(
  apps: (scope: string) => unknown = deployAppsFixture,
  opened: string[] = [],
  livePreview: boolean | "default" = true,
): Promise<HTMLDivElement> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: "preview-card",
      companies: [{ slug: "indigo", displayName: "Indigo", kind: "company", state: "cloud" }] as never,
      listDeployApps: async (scope: string) => ({ ok: true, value: apps(scope) as never }),
      openExternal: (url: string) => opened.push(url),
      ...(livePreview === "default" ? {} : { livePreview }),
    } as never,
  });
  await settle();
  return host;
}

function row(root: HTMLElement, name: string): HTMLElement {
  const match = [...root.querySelectorAll<HTMLElement>(".table .drow:not(.hd)")].find((el) =>
    el.textContent?.includes(name),
  );
  if (!match) throw new Error(`row ${name} not found`);
  return match;
}

async function choose(root: HTMLElement, name: string): Promise<void> {
  row(root, name).click();
  await settle();
}

describe("PersonalDeploymentsPage preview card", () => {
  it("renders one sandboxed, lazy iframe for a Live deployment with a URL", async () => {
    const opened: string[] = [];
    const root = await mountPage(deployAppsFixture, opened);
    await choose(root, "indigo-standup-report");

    const frames = root.querySelectorAll<HTMLIFrameElement>("iframe");
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.closest("[data-testid='deploy-inspector']")).not.toBeNull();
    expect(frame.getAttribute("src")).toBe("https://indigo-standup-report.indigo-hq.com");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("title")).toBe("Preview of indigo-standup-report");
    expect(root.textContent).toContain("Preview may be blank for protected pages");
    expect(root.querySelector(".table iframe")).toBeNull();

    root.querySelector<HTMLButtonElement>("[data-testid='deploy-preview']")!.click();
    expect(opened).toEqual(["https://indigo-standup-report.indigo-hq.com"]);
  });

  it("changes the iframe src when the selection changes", async () => {
    const root = await mountPage();
    await choose(root, "indigo-standup-report");
    await choose(root, "hq-desktop-console-rail-storyboard");

    const frames = root.querySelectorAll<HTMLIFrameElement>("iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.getAttribute("src")).toBe("https://hq-desktop-console-rail-storyboard.indigo-hq.com");
  });

  it("shows no card for a deployment without a URL", async () => {
    const root = await mountPage((scope) => {
      const page = deployAppsFixture(scope);
      return { ...page, apps: page.apps.map((app) => ({ ...app, url: null })) };
    });
    await choose(root, "indigo-standup-report");

    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("[data-testid='deploy-preview']")).toBeNull();
    expect(root.querySelector("[data-testid='deploy-no-preview']")?.textContent).toBe("No preview");
  });

  it("loads no site and opens nothing when the page opens with the default props", async () => {
    const opened: string[] = [];
    const root = await mountPage(deployAppsFixture, opened, "default");

    // The first row is selected on open; its inspector is showing.
    expect(root.querySelector("[data-testid='deploy-inspector']")).not.toBeNull();
    expect(root.querySelector("iframe")).toBeNull();
    expect(root.querySelector("[data-testid='deploy-preview']")).toBeNull();
    expect(root.querySelector("[data-testid='deploy-no-preview']")).toBeNull();
    expect(opened).toEqual([]);

    // Selecting another row still loads nothing.
    await choose(root, "hq-desktop-console-rail-storyboard");
    expect(root.querySelector("iframe")).toBeNull();
    expect(opened).toEqual([]);
  });
});
