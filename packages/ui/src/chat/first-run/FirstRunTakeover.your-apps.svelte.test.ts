// @vitest-environment happy-dom

/**
 * First-run "Your apps": the company the apps connect to can change while the
 * step stays open (the team options answer again, or a new company gets its
 * id). The list for the old company is dropped and the new company's list
 * loads, with no stuck "Looking for your apps". These tests change props on
 * a mounted takeover, so they live in a runes test file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { FirstRunAppsHost, FirstRunTeamHost } from "./first-run-hosts.js";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "./your-apps-host.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

const ACME = { companyUid: "cmp_acme", slug: "acme", name: "Acme" };
const BETA = { companyUid: "cmp_beta", slug: "beta", name: "Beta" };

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

const LOAD: YourAppsLoad = {
  catalog: { "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" } },
  connections: [{ id: "c-slack", domain: "slack.com", provider: "slack" }],
  installations: {},
  canManage: true,
  problem: null,
};

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Your apps, company changes while the step is open", () => {
  it("drops the old company's list still loading and loads the new company's", async () => {
    let finishAcme: (load: YourAppsLoad) => void = () => undefined;
    const load = vi.fn((uid: string) =>
      uid === "cmp_acme" ? new Promise<YourAppsLoad>((resolve) => (finishAcme = resolve)) : Promise.resolve({ ...LOAD, connections: [] }),
    );
    const yourAppsHost: YourAppsHost = {
      detect: vi.fn(async () => SCAN),
      load,
      autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: false, reason: "", retry: false })),
      connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
      setup: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
      undo: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: null })),
    };
    const props = $state({ companies: [ACME] });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(FirstRunTakeover, {
      target: host,
      props: {
        initialName: "Atlas",
        initialStep: "apps",
        creation: { state: "ready", name: "Atlas", bot: { agentUid: "agt_1", handle: "setup" } },
        runtimeReady: { claude: true, codex: false, grok: false },
        get teamOptions() {
          return { invites: [], companies: props.companies };
        },
        teamHost: { join: vi.fn(), create: vi.fn() } as unknown as FirstRunTeamHost,
        appsHost: { catalog: vi.fn(), connect: vi.fn() } as unknown as FirstRunAppsHost,
        yourAppsHost,
        onopenintegrations: vi.fn(),
        initialWorkScan: SCAN,
        onsettled: vi.fn(),
        onconfirmname: vi.fn(),
        onretry: vi.fn(),
        ontalk: vi.fn(),
        oncontinueinchat: vi.fn(),
      },
    });
    await settle();
    expect(load).toHaveBeenCalledWith("cmp_acme");
    expect(q('[data-testid="first-run-apps-loading"]')).not.toBeNull();

    props.companies = [BETA];
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("apps");
    expect(load).toHaveBeenLastCalledWith("cmp_beta");
    expect(q('[data-testid="first-run-apps-loading"]')).toBeNull();
    expect(q('[data-testid="first-run-chip-slack.com"]')).toBeNull();

    // Acme's answer comes back late: it never replaces Beta's list.
    finishAcme(LOAD);
    await settle();
    expect(q('[data-testid="first-run-chip-slack.com"]')).toBeNull();
    expect(q('[data-testid="first-run-app-linear.app"]')).not.toBeNull();
  });
});
