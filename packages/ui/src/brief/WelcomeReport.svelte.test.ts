// @vitest-environment happy-dom

/**
 * The welcome report (US-009): the loading card shows until the brief job's
 * report is ready, then the brief page replaces it. The connect card shows
 * only when the shell passes its inputs (flag on, a host and a company).
 * `ready` flips on a mounted component, so this is a runes test file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, mount, tick, unmount } from "svelte";

import type { FoundWorkApps } from "@hq/platform";

import WelcomeReport, {
  WELCOME_REPORT_LOADING,
  WELCOME_REPORT_NEEDS_ASSISTANT,
  WELCOME_REPORT_SETUP_LABEL,
} from "./WelcomeReport.svelte";
import type { YourAppsHost, YourAppsLoad, YourAppsResult } from "../chat/first-run/your-apps-host.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

const briefPage = createRawSnippet(() => ({ render: () => `<div data-testid="brief-page">Daily brief</div>` }));

const SCAN: FoundWorkApps = {
  platform: "macos",
  scannedAtMs: 1,
  apps: [{ bundleId: "com.linear", name: "Linear" }],
  mcpServers: [],
  sources: [],
  truncated: false,
};
const LOAD: YourAppsLoad = {
  catalog: { "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" } },
  connections: [],
  installations: {},
  canManage: true,
  problem: null,
};

function fakeHost(): YourAppsHost {
  return {
    detect: vi.fn(async () => SCAN),
    load: vi.fn(async () => LOAD),
    autoConnect: vi.fn(async (): Promise<YourAppsResult> => ({ ok: false, reason: "", retry: false })),
    connect: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    setup: vi.fn(() => new Promise<YourAppsResult>(() => undefined)),
    undo: vi.fn(async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: null })),
  };
}

function mountReport(props: Record<string, unknown>): void {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(WelcomeReport, { target, props: props as never });
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  target?.remove();
});

describe("WelcomeReport", () => {
  it("shows the loading card with a progress bar, then the brief page replaces it when the report lands", async () => {
    const props = $state({ ready: false, progress: 0.4 as number | null });
    mountReport({
      get ready() {
        return props.ready;
      },
      get progress() {
        return props.progress;
      },
      children: briefPage,
    });
    await settle();
    const loading = q('[data-testid="welcome-report-loading"]');
    expect(loading?.textContent).toContain(WELCOME_REPORT_LOADING);
    expect(WELCOME_REPORT_LOADING).toBe("Your welcome report is loading");
    expect(loading?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    expect(q('[data-testid="brief-page"]')).toBeNull();

    props.ready = true;
    await settle();
    expect(q('[data-testid="welcome-report-loading"]')).toBeNull();
    expect(q('[data-testid="welcome-report-ready"] [data-testid="brief-page"]')).not.toBeNull();
  });

  it("with no assistant, offers the way to set one up instead of a loading card", async () => {
    const onsetup = vi.fn();
    mountReport({ ready: false, progress: null, onsetup, children: briefPage });
    await settle();
    expect(q('[data-testid="welcome-report-loading"]')).toBeNull();
    expect(q('[role="progressbar"]')).toBeNull();
    expect(q('[data-testid="welcome-report-setup"]')?.textContent).toContain(WELCOME_REPORT_NEEDS_ASSISTANT);
    const button = q<HTMLButtonElement>('[data-testid="welcome-report-setup-button"]');
    expect(button?.textContent?.trim()).toBe(WELCOME_REPORT_SETUP_LABEL);
    button!.click();
    expect(onsetup).toHaveBeenCalledTimes(1);
  });

  it("renders the connect card from the scan when the shell passes it, and leaves it out when connect is null", async () => {
    mountReport({
      ready: false,
      connect: { host: fakeHost(), company: { uid: "cmp_acme", name: "Acme" }, assistantName: "Atlas" },
      children: briefPage,
    });
    await settle();
    expect(q('[data-testid="welcome-connect-card"] [data-testid="first-run-app-linear.app"]')).not.toBeNull();
    await unmount(component!);
    component = null;
    target.remove();

    mountReport({ ready: false, connect: null, children: briefPage });
    await settle();
    expect(q('[data-testid="welcome-report"]')).not.toBeNull();
    expect(q('[data-testid="welcome-connect-card"]')).toBeNull();
  });

  it("says the assistant made the report and Meet <Name> opens its DM", async () => {
    const onmeet = vi.fn();
    mountReport({ ready: true, madeBy: { name: "Atlas", onmeet }, children: briefPage });
    await settle();
    const line = q('[data-testid="welcome-report-made-by"]');
    expect(line?.textContent).toContain("Atlas made this report.");
    const meet = q('[data-testid="welcome-report-meet"]');
    expect(meet?.textContent).toBe("Meet Atlas");
    meet!.click();
    expect(onmeet).toHaveBeenCalledTimes(1);
  });

  it("with no assistant yet, says the assistant will make the next one and has no button", async () => {
    mountReport({ ready: true, madeBy: null, children: briefPage });
    await settle();
    expect(q('[data-testid="welcome-report-made-by"]')?.textContent?.trim()).toBe("Your assistant will make the next one.");
    expect(q('[data-testid="welcome-report-meet"]')).toBeNull();
  });
});
