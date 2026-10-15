// @vitest-environment happy-dom

/**
 * The welcome report's connect card (US-009): it offers only the apps the
 * launch scan found, through the shared YourAppsHost, one browser sign-in at
 * a time. Nothing found, or a scan that could not run, shows no card.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import WelcomeConnectCard from "./WelcomeConnectCard.svelte";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "./your-apps-host.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

const SCAN: FoundWorkApps = {
  platform: "macos",
  scannedAtMs: 1,
  apps: [
    { bundleId: "com.linear", name: "Linear" },
    { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
  ],
  mcpServers: [],
  sources: [],
  truncated: false,
};
const EMPTY_SCAN: FoundWorkApps = { ...SCAN, apps: [] };

const LOAD: YourAppsLoad = {
  catalog: {
    "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
    "slack.com": { entryId: "e-slack", name: "Slack", authClass: "oauth" },
  },
  connections: [],
  installations: {},
  canManage: true,
  problem: null,
};

function fakeHost(scan: FoundWorkApps | null): YourAppsHost {
  return {
    detect: vi.fn(async () => scan),
    load: vi.fn(async () => LOAD),
    autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: false, reason: "", retry: false })),
    connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    setup: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    undo: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: null })),
  };
}

function mountCard(host: YourAppsHost): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(WelcomeConnectCard, {
    target,
    props: { host, company: { uid: "cmp_acme", name: "Acme" }, assistantName: "Atlas" },
  });
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  target?.remove();
});

describe("WelcomeConnectCard", () => {
  it("offers the apps the scan found, loaded for the company", async () => {
    const host = fakeHost(SCAN);
    mountCard(host);
    await settle();
    expect(host.detect).toHaveBeenCalledTimes(1);
    expect(host.load).toHaveBeenCalledWith("cmp_acme");
    expect(q('[data-testid="welcome-connect-card"]')).not.toBeNull();
    expect(q('[data-testid="first-run-app-linear.app"]')).not.toBeNull();
    expect(q('[data-testid="first-run-app-slack.com"]')).not.toBeNull();
  });

  it("runs one browser sign-in at a time", async () => {
    const host = fakeHost(SCAN);
    mountCard(host);
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')?.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-slack.com"]')?.click();
    await settle();
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_acme", expect.objectContaining({ domain: "linear.app" }), expect.anything());
  });

  it("shows no card when the scan found nothing or could not run", async () => {
    mountCard(fakeHost(EMPTY_SCAN));
    await settle();
    expect(q('[data-testid="welcome-connect-card"]')).toBeNull();
    await unmount(component!);
    component = null;
    target.remove();

    mountCard(fakeHost(null));
    await settle();
    expect(q('[data-testid="welcome-connect-card"]')).toBeNull();
  });
});
