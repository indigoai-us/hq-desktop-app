// @vitest-environment happy-dom

/**
 * First-run "Your apps" (integration auto-detect MVP) in the takeover: one
 * step replaces Note taker and Project management; found apps are grouped by
 * status; no-sign-in catalog apps connect by themselves for an owner or admin
 * and can be undone; the rest wait for a press; Continue is always live; the
 * handoff carries what was connected. Without the host the old two steps stay.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { FirstRunAppsHost, FirstRunSettled, FirstRunTeamHost } from "./first-run-hosts.js";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "./your-apps-host.js";
import { FIRST_RUN_BANNED_DASHES } from "./visual-first-run.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const text = (sel: string): string => q(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";

const ACME = { companyUid: "cmp_acme", slug: "acme", name: "Acme" };

const SCAN: FoundWorkApps = {
  platform: "macos",
  scannedAtMs: 1,
  apps: [
    { bundleId: "com.linear", name: "Linear" },
    { bundleId: "us.zoom.xos", name: "zoom.us" },
    { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
    { bundleId: "com.docker.docker", name: "Docker" },
  ],
  mcpServers: [
    { tool: "codex", name: "aws", transport: "http", host: "knowledge-mcp.global.api.aws", local: false, hasCredentialFields: false, enabled: true },
    { tool: "claude_code", name: "posthog", transport: "http", host: "mcp.posthog.com", local: false, hasCredentialFields: true, enabled: true },
  ],
  sources: [],
  truncated: false,
};

const LOAD: YourAppsLoad = {
  catalog: {
    "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
    "api.aws": { entryId: "e-aws", name: "AWS Knowledge", authClass: "none" },
    "posthog.com": { entryId: "e-ph", name: "PostHog", authClass: "key" },
    "zoom.us": null,
  },
  connections: [{ id: "c-slack", domain: "slack.com", provider: "slack" }],
  installations: {},
  canManage: true,
  problem: null,
};

function yourHost(over: Partial<YourAppsHost> = {}): YourAppsHost {
  return {
    detect: vi.fn(async () => SCAN),
    load: vi.fn(async () => LOAD),
    autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: "c-aws", installationId: "inst-aws" })),
    connect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: "c-lin", installationId: null })),
    setup: vi.fn(async (): Promise<YourAppsResult> => ({ ok: false, reason: "HQ can't connect Zoom yet.", retry: false, unsupported: true })),
    undo: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: "inst-aws" })),
    ...over,
  };
}

function render(opts: { yourApps?: YourAppsHost | null; scan?: FoundWorkApps | null; load?: YourAppsLoad } = {}) {
  const yourAppsHost = opts.yourApps === undefined ? yourHost(opts.load ? { load: vi.fn(async () => opts.load!) } : {}) : opts.yourApps;
  const onsettled = vi.fn((_s: FirstRunSettled) => undefined);
  const onopenintegrations = vi.fn();
  const teamHost: FirstRunTeamHost = { join: vi.fn(), create: vi.fn() } as unknown as FirstRunTeamHost;
  const appsHost: FirstRunAppsHost = {
    catalog: vi.fn(async () => ({ ok: true, apps: [], connected: [] })),
    connect: vi.fn(async () => ({ ok: true })),
  } as unknown as FirstRunAppsHost;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Atlas",
      initialStep: opts.yourApps === null ? "notes" : "apps",
      creation: { state: "ready", name: "Atlas", bot: { agentUid: "agt_1", handle: "setup" } },
      runtimeReady: { claude: true, codex: false, grok: false },
      teamOptions: { invites: [], companies: [ACME] },
      teamHost,
      appsHost,
      yourAppsHost,
      onopenintegrations,
      initialWorkScan: opts.scan === undefined ? SCAN : opts.scan,
      onsettled,
      onconfirmname: vi.fn(),
      onretry: vi.fn(),
      ontalk: vi.fn(),
      oncontinueinchat: vi.fn(),
    },
  });
  return { yourAppsHost, onsettled, onopenintegrations, appsHost };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Your apps", () => {
  it("replaces Note taker and Project management with one step", async () => {
    render();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("apps");
    expect(text("h1")).toBe("Connect your work apps.");
    // name, team, tools, apps, done: one bar fewer than with the two app screens.
    expect(document.querySelectorAll('[data-testid="new-bot-progress"] span')).toHaveLength(5);
  });

  it("groups found apps by status and auto-connects the no-sign-in catalog app", async () => {
    const { yourAppsHost } = render();
    await settle();
    expect(yourAppsHost!.load).toHaveBeenCalledWith("cmp_acme");
    expect(yourAppsHost!.autoConnect).toHaveBeenCalledTimes(1);
    expect(yourAppsHost!.autoConnect).toHaveBeenCalledWith("cmp_acme", "e-aws", "AWS Knowledge");
    expect(q('[data-testid="first-run-chip-slack.com"]')?.textContent).toContain("team");
    expect(q('[data-testid="first-run-chip-api.aws"]')?.textContent).toContain("no sign-in");
    expect(q('[data-testid="first-run-undo-api.aws"]')).not.toBeNull();
    expect(q('[data-testid="first-run-app-linear.app"]')?.getAttribute("data-action")).toBe("connect");
    expect(q('[data-testid="first-run-app-posthog.com"]')?.textContent).toContain("Add it later from Integrations");
    expect(q('[data-testid="first-run-connect-posthog.com"]')).toBeNull();
    expect(q('[data-testid="first-run-app-zoom.us"]')?.getAttribute("data-action")).toBe("setup");
    expect(text('[data-testid="first-run-apps-also"]')).toContain("Docker");
    // The company name renders through CompanyLabel (its monogram, then the name).
    const status = text('[data-testid="first-run-apps-status"]');
    expect(status.startsWith("2 connected to ")).toBe(true);
    expect(status.endsWith("Acme. You can connect more later from Integrations.")).toBe(true);
    const all = document.body.textContent ?? "";
    for (const dash of FIRST_RUN_BANNED_DASHES) expect(all).not.toContain(dash);
  });

  it("connects on a press, sets up from docs, and undoes an automatic connection", async () => {
    const { yourAppsHost } = render();
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')!.click();
    await settle();
    expect(yourAppsHost!.connect).toHaveBeenCalledWith("cmp_acme", expect.objectContaining({ domain: "linear.app", action: "connect" }), expect.anything());
    expect(q('[data-testid="first-run-chip-linear.app"]')?.textContent).toContain("you");

    q<HTMLButtonElement>('[data-testid="first-run-connect-zoom.us"]')!.click();
    await settle();
    expect(yourAppsHost!.setup).toHaveBeenCalled();
    expect(q('[data-testid="first-run-app-zoom.us"]')?.getAttribute("data-action")).toBe("not-yet");

    q<HTMLButtonElement>('[data-testid="first-run-undo-api.aws"]')!.click();
    await settle();
    expect(yourAppsHost!.undo).toHaveBeenCalledWith("cmp_acme", "inst-aws");
    expect(q('[data-testid="first-run-chip-api.aws"]')).toBeNull();
    expect(q('[data-testid="first-run-app-api.aws"]')?.getAttribute("data-action")).toBe("install");
  });

  it("shows a failed connect on its tile with Try again", async () => {
    render({ yourApps: yourHost({ connect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: false, reason: "Linear did not finish connecting. Try again.", retry: true })) }) });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')!.click();
    await settle();
    const tile = q('[data-testid="first-run-app-linear.app"]');
    expect(tile?.getAttribute("data-state")).toBe("failed");
    expect(q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')?.textContent).toBe("Try again");
  });

  it("sends Slack to Integrations when the company does not have it", async () => {
    const { onopenintegrations } = render({ load: { ...LOAD, connections: [] } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-slack.com"]')!.click();
    expect(onopenintegrations).toHaveBeenCalledWith("cmp_acme");
  });

  it("a member auto-connects nothing and sees admin-only tiles", async () => {
    const { yourAppsHost } = render({ load: { ...LOAD, canManage: false } });
    await settle();
    expect(yourAppsHost!.autoConnect).not.toHaveBeenCalled();
    expect(q('[data-testid="first-run-app-linear.app"]')?.textContent).toContain("An admin can connect this");
    expect(q('[data-testid="first-run-connect-linear.app"]')).toBeNull();
  });

  it("with nothing found offers the catalog's note takers and project tools", async () => {
    render({ scan: null, load: { ...LOAD, catalog: { ...LOAD.catalog, "fireflies.ai": { entryId: "f", name: "Fireflies", authClass: "oauth" } } } });
    await settle();
    expect(text('[data-testid="first-run-apps-lead"]')).toMatch(/^We didn't find work apps on this/);
    expect(q('[data-testid="first-run-app-fireflies.ai"]')).not.toBeNull();
    expect(q('[data-testid="first-run-app-linear.app"]')).not.toBeNull();
  });

  it("Continue is live while a connect runs, and the handoff carries the connected apps", async () => {
    const { onsettled } = render({ yourApps: yourHost({ connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)) }) });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')!.click();
    await settle();
    const next = q<HTMLButtonElement>('[data-testid="first-run-next"]')!;
    expect(next.disabled).toBe(false);
    expect(next.textContent).toContain("Continue");
    next.click();
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("done");
    const last = onsettled.mock.calls.at(-1)?.[0];
    expect(last?.apps).toEqual({
      notes: null,
      projects: null,
      others: [
        { name: "Slack", domain: "slack.com" },
        { name: "AWS Knowledge", domain: "api.aws" },
      ],
    });
    expect(text('[data-testid="first-run-summary-apps"]')).toBe("2 connected");
  });

  it("without the host keeps Note taker and Project management", async () => {
    render({ yourApps: null });
    await settle();
    expect(q('[data-testid="first-run-step"]')?.getAttribute("data-step")).toBe("notes");
    expect(q('[data-testid="first-run-apps-ready"]')).toBeNull();
  });
});
