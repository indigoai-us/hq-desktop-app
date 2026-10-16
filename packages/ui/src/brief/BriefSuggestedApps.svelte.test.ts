// @vitest-environment happy-dom

/**
 * The suggested integrations in the welcome report: the work apps the scan
 * found, a row each with why it was suggested and a Connect action through
 * the shared YourAppsHost, one browser sign-in at a time. With no company
 * the rows still show, and Connect opens the new-company flow first, then
 * connects the app in the company it made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import Harness from "./BriefSuggestedAppsHarness.test-support.svelte";
import { hostComputerNoun } from "@hq/platform";
import { evidenceLine, matchFoundApps } from "../chat/first-run/found-apps.js";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "../chat/first-run/your-apps-host.js";
import { NEW_COMPANY_WAIT_MS, WelcomeConnectSession } from "./welcome-connect-session.svelte.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends HTMLElement = HTMLElement>(id: string): T | null => target.querySelector<T>(`[data-testid="${id}"]`);

const SCAN: FoundWorkApps = {
  platform: "macos",
  scannedAtMs: 1,
  apps: [
    { bundleId: "com.linear", name: "Linear" },
    { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
  ],
  mcpServers: [
    {
      tool: "claude_code",
      name: "notion",
      transport: "http",
      host: "mcp.notion.com",
      local: false,
      hasCredentialFields: false,
      enabled: true,
    },
  ],
  sources: [],
  truncated: false,
};

const LOAD: YourAppsLoad = {
  catalog: {
    "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
    "slack.com": { entryId: "e-slack", name: "Slack", authClass: "oauth" },
    "notion.com": { entryId: "e-notion", name: "Notion", authClass: "oauth" },
  },
  connections: [],
  installations: {},
  canManage: true,
  problem: null,
};

function fakeHost(): YourAppsHost {
  return {
    detect: vi.fn(async () => SCAN),
    load: vi.fn(async () => LOAD),
    autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({
      ok: false,
      reason: "",
      retry: false,
    })),
    connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    setup: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    undo: vi.fn(async (): Promise<YourAppsResult> => ({
      ok: true,
      connectionId: null,
      installationId: null,
    })),
  };
}

type Company = { uid: string; name: string } | null;

function render(
  host: YourAppsHost,
  opts: {
    company?: Company;
    onnewcompany?: () => Promise<string | null>;
    session?: WelcomeConnectSession;
    scan?: FoundWorkApps;
  } = {},
): { setCompany: (next: Company) => void } {
  target = document.createElement("div");
  document.body.appendChild(target);
  const control: { setCompany?: (next: Company) => void } = {};
  component = mount(Harness, {
    target,
    props: {
      scan: matchFoundApps(opts.scan ?? SCAN),
      host,
      company: opts.company === undefined ? { uid: "cmp_acme", name: "Acme" } : opts.company,
      onnewcompany: opts.onnewcompany,
      session: opts.session,
      control,
    },
  });
  return { setCompany: (next) => control.setCompany!(next) };
}

afterEach(() => {
  vi.useRealTimers();
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("BriefSuggestedApps with a company", () => {
  it("offers the apps the scan found, loaded for the company, with Connect", async () => {
    const host = fakeHost();
    render(host);
    await settle();
    expect(host.detect).not.toHaveBeenCalled();
    expect(host.load).toHaveBeenCalledWith("cmp_acme");
    expect(q("suggested-app-linear.app")?.dataset.kind).toBe("tile");
    expect(q("suggested-app-slack.com")?.dataset.kind).toBe("tile");
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Connect");
  });

  it("runs one browser sign-in at a time", async () => {
    const host = fakeHost();
    render(host);
    await settle();
    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Waiting");
    q<HTMLButtonElement>("suggested-app-connect-notion.com")!.click();
    await settle();
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_acme", expect.objectContaining({ domain: "linear.app" }), expect.anything());
  });

  it("shows no rows when the scan found nothing", async () => {
    render(fakeHost(), { scan: { ...SCAN, apps: [], mcpServers: [] } });
    await settle();
    expect(q("suggested-apps")).toBeNull();
  });

  it("never auto-connects an app the person undid, after a remount (a later Daily Brief visit)", async () => {
    const host = fakeHost();
    // Linear needs no sign-in, so the group connects it by itself.
    host.load = vi.fn(async () => ({
      ...LOAD,
      catalog: {
        ...LOAD.catalog,
        "linear.app": {
          entryId: "e-linear",
          name: "Linear",
          authClass: "none" as const,
        },
      },
    }));
    host.autoConnect = vi.fn(async (): Promise<YourAppsResult> => ({
      ok: true,
      connectionId: "conn-linear",
      installationId: "inst-linear",
    }));
    const session = new WelcomeConnectSession();
    render(host, { session });
    await settle();
    expect(host.autoConnect).toHaveBeenCalledTimes(1);
    expect(host.autoConnect).toHaveBeenCalledWith("cmp_acme", "e-linear", "Linear");
    expect(q("suggested-app-linear.app")?.dataset.kind).toBe("chip");

    q<HTMLButtonElement>("suggested-app-undo-linear.app")!.click();
    await settle();
    expect(host.undo).toHaveBeenCalledWith("cmp_acme", "inst-linear");
    expect(session.memoryFor("cmp_acme").undone.has("linear.app")).toBe(true);

    unmount(component!);
    component = null;
    target.remove();

    render(host, { session });
    await settle();
    expect(host.autoConnect).toHaveBeenCalledTimes(1);
    expect(q("suggested-app-linear.app")?.dataset.kind).toBe("tile");
  });
});

describe("BriefSuggestedApps with no company", () => {
  it("still shows the found apps with why each was suggested", async () => {
    const host = fakeHost();
    render(host, { company: null, onnewcompany: vi.fn(async () => null) });
    await settle();
    expect(host.load).not.toHaveBeenCalled();
    expect(q("suggested-app-linear.app")?.dataset.kind).toBe("found");
    expect(q("suggested-app-note-linear.app")?.textContent).toBe(evidenceLine({ app: true, tools: [] }, hostComputerNoun()));
    expect(q("suggested-app-note-linear.app")?.textContent).not.toBe("");
    expect(q("suggested-app-note-notion.com")?.textContent).toBe("In Claude Code");
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Connect");
  });

  it("Connect opens the new-company flow, then connects the app in the new company", async () => {
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    const { setCompany } = render(host, { company: null, onnewcompany });
    await settle();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    expect(onnewcompany).toHaveBeenCalledTimes(1);
    expect(host.connect).not.toHaveBeenCalled();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Waiting");
    expect(q<HTMLButtonElement>("suggested-app-connect-notion.com")?.disabled).toBe(true);

    answer("cmp_new");
    await settle();
    setCompany({ uid: "cmp_new", name: "New Co" });
    await settle();
    expect(host.load).toHaveBeenCalledWith("cmp_new");
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_new", expect.objectContaining({ domain: "linear.app" }), expect.anything());
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Waiting");
  });

  it("connects in the new company when the report switched to it before the new-company flow answered", async () => {
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    const { setCompany } = render(host, { company: null, onnewcompany });
    await settle();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    setCompany({ uid: "cmp_new", name: "New Co" });
    await settle();
    expect(host.connect).not.toHaveBeenCalled();
    answer("cmp_new");
    await settle();
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_new", expect.objectContaining({ domain: "linear.app" }), expect.anything());
  });

  it("closing the new-company flow without a company leaves Connect ready again", async () => {
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    render(host, { company: null, onnewcompany });
    await settle();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    answer(null);
    await settle();
    expect(host.connect).not.toHaveBeenCalled();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Connect");
    expect(q<HTMLButtonElement>("suggested-app-connect-notion.com")?.disabled).toBe(false);
  });

  it("stops waiting after the bounded wait when the new company never becomes the report's, with Try again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    render(host, { company: null, onnewcompany });
    await settle();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    answer("cmp_new");
    await settle();
    vi.advanceTimersByTime(NEW_COMPANY_WAIT_MS - 1);
    await settle();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Waiting");

    vi.advanceTimersByTime(1);
    await settle();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Try again");
    expect(q("suggested-app-note-linear.app")?.textContent).toBe("Didn't connect");
    expect(q<HTMLButtonElement>("suggested-app-connect-notion.com")?.disabled).toBe(false);
    expect(host.connect).not.toHaveBeenCalled();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    expect(onnewcompany).toHaveBeenCalledTimes(2);
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Waiting");
  });

  it("a different company than the new one ends the wait: the app says it didn't connect, and Try again connects it there", async () => {
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    const { setCompany } = render(host, { company: null, onnewcompany });
    await settle();

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    answer("cmp_new");
    await settle();
    setCompany({ uid: "cmp_other", name: "Other Co" });
    await settle();
    expect(host.load).toHaveBeenCalledWith("cmp_other");
    expect(host.connect).not.toHaveBeenCalled();
    expect(q("suggested-app-connect-linear.app")?.textContent?.trim()).toBe("Try again");
    expect(q("suggested-app-note-linear.app")?.textContent).toBe("Didn't connect");

    q<HTMLButtonElement>("suggested-app-connect-linear.app")!.click();
    await settle();
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_other", expect.objectContaining({ domain: "linear.app" }), expect.anything());
  });
});
