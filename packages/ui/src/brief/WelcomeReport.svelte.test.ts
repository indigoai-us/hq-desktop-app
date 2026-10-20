// @vitest-environment happy-dom

/**
 * The welcome report (US-009): the loading card shows until the brief job's
 * report is ready, then the brief page replaces it. The "Connect your AI
 * apps" card, with the suggested integrations, is never above the report: it
 * sits under the loading, setup or held card, and inside the brief body once
 * the report is ready.
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
import ReportWithBrief from "./WelcomeReportBriefHarness.test-support.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { riseFrame, riseRevealAt, welcomeRiseSources } from "./brief-rise.js";
import { welcomeRiseBriefInput } from "./welcome-rise-run.js";
import { parseWelcome } from "./brief-welcome.js";
import core from "./fixtures/core-1432-welcome.json";
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

/** A welcome whose one thing is a prompt, so the first view launches it through the brief's start button. */
const TOUR_PROMPT = "Give me a short tour of my HQ.";
const TOUR = {
  first_run: true,
  actions: [{ id: "tree", kind: "open_tree", label: "Look around your HQ", reason: "38 projects so far.", launch_prompt: TOUR_PROMPT, primary: true }],
};

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
    expect(q('[data-testid="brief-rise"]')).not.toBeNull();
    expect(loading?.querySelector(".card")).toBeNull();
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

  it("a job held back on a fix keeps the report's heading with the reason and the fix, never the loading bar", async () => {
    const onfix = vi.fn();
    mountReport({
      ready: false,
      blocked: { message: "Quill has no model connected on this computer.", label: "Connect a model", onfix },
      children: briefPage,
    });
    await settle();
    expect(q('[data-testid="welcome-report-loading"]')).toBeNull();
    expect(q('[role="progressbar"]')).toBeNull();
    expect(q('[data-testid="brief-page"]')).toBeNull();
    const card = q('[data-testid="welcome-report-blocked"]');
    expect(card?.querySelector("h2")?.textContent?.trim()).toBe(WELCOME_REPORT_NEEDS_ASSISTANT);
    expect(card?.querySelector("p")?.textContent?.trim()).toBe("Quill has no model connected on this computer.");
    const button = q<HTMLButtonElement>('[data-testid="welcome-report-blocked-fix"]');
    expect(button?.textContent?.trim()).toBe("Connect a model");
    button!.click();
    expect(onfix).toHaveBeenCalledTimes(1);
  });

  it("says what the fix returned when it could not finish, and a fix that throws says something went wrong", async () => {
    let answer: () => Promise<string | null> = async () => "Could not start Quill. Try again.";
    const onfix = vi.fn(() => answer());
    mountReport({
      ready: false,
      blocked: { message: "Quill is not running.", label: "Start it", onfix },
      children: briefPage,
    });
    await settle();
    expect(q('[data-testid="welcome-report-blocked-error"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="welcome-report-blocked-fix"]')!.click();
    await settle();
    expect(q('[data-testid="welcome-report-blocked-error"]')?.textContent?.trim()).toBe("Could not start Quill. Try again.");

    answer = async () => {
      throw new Error("host gone");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    q<HTMLButtonElement>('[data-testid="welcome-report-blocked-fix"]')!.click();
    await settle();
    expect(q('[data-testid="welcome-report-blocked-error"]')?.textContent?.trim()).toBe("Something went wrong.");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    answer = async () => null;
    q<HTMLButtonElement>('[data-testid="welcome-report-blocked-fix"]')!.click();
    await settle();
    expect(q('[data-testid="welcome-report-blocked-error"]')).toBeNull();
    expect(onfix).toHaveBeenCalledTimes(3);
  });

  it("puts the suggested apps from the scan under the loading card, and leaves the card out when nothing is passed", async () => {
    const host = fakeHost();
    mountReport({
      ready: false,
      connect: { host, company: { uid: "cmp_acme", name: "Acme" } },
      children: briefPage,
    });
    await settle();
    expect(host.detect).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="connect-ai-apps-card"] [data-testid="suggested-app-linear.app"]')).not.toBeNull();
    await unmount(component!);
    component = null;
    target.remove();

    mountReport({ ready: false, connect: null, aiApps: null, children: briefPage });
    await settle();
    expect(q('[data-testid="welcome-report"]')).not.toBeNull();
    expect(q('[data-testid="connect-ai-apps-card"]')).toBeNull();
  });

  it("never puts the connect card above the report: under the loading card and under the setup card", async () => {
    const aiApps = { detect: async () => SCAN, cli: { claudeCode: true, codex: false } };
    mountReport({ ready: false, aiApps, connect: { host: fakeHost(), company: null, onnewcompany: vi.fn(async () => null) }, children: briefPage });
    await settle();
    const loading = q('[data-testid="welcome-report-loading"]')!;
    const card = q('[data-testid="connect-ai-apps-card"]')!;
    expect(card).not.toBeNull();
    expect(loading.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('[data-testid="welcome-report-connect"]')?.contains(card)).toBe(true);
    // With no company the suggestions still show, with a Connect that opens a new company.
    expect(q<HTMLElement>('[data-testid="suggested-app-linear.app"]')?.dataset.kind).toBe("found");
    expect(q('[data-testid="suggested-app-connect-linear.app"]')).not.toBeNull();
    await unmount(component!);
    component = null;
    target.remove();

    mountReport({ ready: false, aiApps, onsetup: vi.fn(), children: briefPage });
    await settle();
    const setup = q('[data-testid="welcome-report-setup"]')!;
    const setupCard = q('[data-testid="connect-ai-apps-card"]')!;
    expect(setupCard).not.toBeNull();
    expect(setup.compareDocumentPosition(setupCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a Connect in progress when the status changes from loading to held", async () => {
    const props = $state({ blocked: null as { message: string; label: string; onfix: () => void } | null });
    const onnewcompany = vi.fn(() => new Promise<string | null>(() => undefined));
    mountReport({
      ready: false,
      connect: { host: fakeHost(), company: null, onnewcompany },
      get blocked() {
        return props.blocked;
      },
      children: briefPage,
    });
    await settle();
    const card = q('[data-testid="connect-ai-apps-card"]');
    q<HTMLButtonElement>('[data-testid="suggested-app-connect-linear.app"]')!.click();
    await settle();
    expect(onnewcompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="suggested-app-connect-linear.app"]')?.textContent?.trim()).toBe("Waiting");

    props.blocked = { message: "Quill is not running.", label: "Start it", onfix: vi.fn() };
    await settle();
    expect(q('[data-testid="welcome-report-blocked"]')).not.toBeNull();
    expect(q('[data-testid="connect-ai-apps-card"]')).toBe(card);
    expect(q('[data-testid="suggested-app-connect-linear.app"]')?.textContent?.trim()).toBe("Waiting");
  });

  it("once the report is ready the connect UI moves into the first view's Connect card, the only connect UI on the page", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const NOW = new Date(2026, 9, 8, 7, 42);
    const onopenaiapps = vi.fn();
    component = mount(ReportWithBrief, {
      target,
      props: {
        input: { ...octoberEightBrief(NOW), today: "2026-10-08" },
        welcome: parseWelcome(core.showcase_personal), firstViewData: { welcome: core.showcase_personal, importReport: null },
        actions: { destinations: { assistantName: "Atlas", claudeCode: true, codex: false }, onassistant: vi.fn(async () => null) },
        report: {
          aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false }, onopenaiapps },
          connect: { host: fakeHost(), company: { uid: "cmp_acme", name: "Acme" } },
        },
      },
    });
    await settle();
    const brief = q('[data-testid="welcome-report-ready"]')!;
    const card = q('[data-testid="first-view-connect"]')!;
    expect(card).not.toBeNull();
    expect(brief.contains(card)).toBe(true);
    // The held card under the loading screen is gone, and nothing else offers Connect.
    expect(q('[data-testid="welcome-report-connect"]')).toBeNull();
    expect(document.querySelectorAll('[data-testid="first-view-connect"]')).toHaveLength(1);
    expect(q('[data-testid="connect-ai-apps-card"]')).toBeNull();
    // An AI app HQ did not find connects through the AI-apps settings.
    const cursor = card.querySelector<HTMLButtonElement>('[data-testid="first-view-connect-row"][data-harness="cursor"] button')!;
    expect(cursor.textContent?.trim()).toBe("Connect");
    cursor.click();
    expect(onopenaiapps).toHaveBeenCalledTimes(1);

    // Review mode (Shift+A) shows the full catalogue, with no second connect card in it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    await settle();
    expect(q('[data-testid="first-view-grid"]')).toBeNull();
    expect(q('[data-testid="brief-action-cards"]')).not.toBeNull();
    expect(q('[data-testid="brief-dropped"]')).not.toBeNull();
    expect(q('[data-testid="connect-ai-apps-card"]')).toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    await settle();
  });

  it("keeps a sign-in running when the report turns ready mid-Connect: it lands as connected in the first view, with one scan", async () => {
    const props = $state({ ready: false });
    const host = fakeHost();
    let signal: AbortSignal | null = null;
    let finish: (res: YourAppsResult) => void = () => undefined;
    host.connect = vi.fn((_uid: string, _tile: unknown, sig: AbortSignal) => {
      signal = sig;
      return new Promise<YourAppsResult>((resolve) => (finish = resolve));
    }) as YourAppsHost["connect"];
    const detect = vi.fn(async () => SCAN);
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ReportWithBrief, {
      target,
      props: {
        input: { ...octoberEightBrief(new Date(2026, 9, 8, 7, 42)), today: "2026-10-08" },
        get ready() {
          return props.ready;
        },
        report: {
          aiApps: { detect, cli: { claudeCode: true, codex: false } },
          connect: { host, company: { uid: "cmp_acme", name: "Acme" } },
        },
      },
    });
    await settle();
    q<HTMLButtonElement>('[data-testid="welcome-report-connect"] [data-testid="suggested-app-connect-linear.app"]')!.click();
    await settle();
    expect(host.connect).toHaveBeenCalledTimes(1);

    props.ready = true;
    await settle();
    expect(signal!.aborted).toBe(false);
    // The sign-in carries into the first view's Connect card.
    expect(q('[data-testid="first-view-grid"]')).not.toBeNull();
    expect(q('[data-testid="first-view-connect"] [data-testid="suggested-app-connect-linear.app"]')?.textContent?.trim()).toBe("Waiting");

    finish({ ok: true, connectionId: "conn-linear", installationId: null });
    await settle();
    expect(q<HTMLElement>('[data-testid="first-view-connect"] [data-testid="suggested-app-linear.app"]')?.dataset.kind).toBe("chip");
    expect(detect).toHaveBeenCalledTimes(1);
    expect(host.load).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledTimes(1);
  });

  it("keeps a Connect waiting on a new company when the report turns ready, in the first view, and connects once the company lands", async () => {
    const props = $state({ ready: false, company: null as { uid: string; name: string } | null });
    const host = fakeHost();
    let answer: (uid: string | null) => void = () => undefined;
    const onnewcompany = vi.fn(() => new Promise<string | null>((resolve) => (answer = resolve)));
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ReportWithBrief, {
      target,
      props: {
        input: { ...octoberEightBrief(new Date(2026, 9, 8, 7, 42)), today: "2026-10-08" },
        get ready() {
          return props.ready;
        },
        report: {
          aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false } },
          get connect() {
            return { host, company: props.company, onnewcompany };
          },
        },
      },
    });
    await settle();
    q<HTMLButtonElement>('[data-testid="welcome-report-connect"] [data-testid="suggested-app-connect-linear.app"]')!.click();
    await settle();
    expect(onnewcompany).toHaveBeenCalledTimes(1);

    props.ready = true;
    await settle();
    expect(q('[data-testid="first-view-grid"]')).not.toBeNull();
    expect(q('[data-testid="first-view-connect"] [data-testid="suggested-app-connect-linear.app"]')?.textContent?.trim()).toBe("Waiting");

    answer("cmp_new");
    props.company = { uid: "cmp_new", name: "New Co" };
    await settle();
    expect(onnewcompany).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledTimes(1);
    expect(host.connect).toHaveBeenCalledWith("cmp_new", expect.objectContaining({ domain: "linear.app" }), expect.anything());
  });

  it("shows Open Claude Code on the welcome edition and calls through when pressed", async () => {
    const onopen = vi.fn();
    mountReport({
      ready: false,
      openTool: {
        label: "Open Claude Code",
        detail: "Claude Code is set up with HQ. Open it to keep working there.",
        busy: false,
        error: null,
        onopen,
      },
      children: briefPage,
    });
    await settle();
    const button = q<HTMLButtonElement>('[data-testid="brief-open-tool-button"]');
    expect(button?.textContent?.trim()).toBe("Open Claude Code");
    expect(q('[data-testid="brief-open-tool-detail"]')?.textContent).toBe(
      "Claude Code is set up with HQ. Open it to keep working there.",
    );
    const loading = q('[data-testid="welcome-report-loading"]');
    expect(loading).not.toBeNull();
    // US-019: nothing sits above the sunrise; the bar follows it.
    const bar = q('[data-testid="brief-open-tool"]')!;
    expect(loading!.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It sits in the inset slot under the rise, not flush against the window edge.
    expect(q('[data-testid="welcome-report-open-tool"]')?.contains(bar)).toBe(true);
    button!.click();
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it("puts the Open bar after the setup and blocked cards, never above them (US-019)", async () => {
    const openTool = { label: "Open Claude Code", detail: null, busy: false, error: null, onopen: vi.fn() };
    for (const state of [
      { onsetup: vi.fn(), card: "welcome-report-setup" },
      { blocked: { message: "Quill has no model connected on this computer.", label: "Connect a model", onfix: vi.fn() }, card: "welcome-report-blocked" },
    ]) {
      const { card: testid, ...rest } = state;
      mountReport({ ready: false, progress: null, openTool, ...rest, children: briefPage });
      await settle();
      const card = q(`[data-testid="${testid}"]`)!;
      const bar = q('[data-testid="brief-open-tool"]')!;
      expect(card).not.toBeNull();
      expect(bar).not.toBeNull();
      expect(card.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      if (component) await unmount(component);
      component = null;
      target?.remove();
    }
  });

  it("leaves the Open action out when no tool was prepared", async () => {
    mountReport({ ready: false, children: briefPage });
    await settle();
    expect(q('[data-testid="brief-open-tool-button"]')).toBeNull();
  });

  it("draws no made-by line or Meet button above the brief, even with a named assistant (US-019)", async () => {
    for (const name of ["Atlas", "Your assistant"]) {
      const onmeet = vi.fn();
      mountReport({ ready: true, madeBy: { name, onmeet }, children: briefPage });
      await settle();
      expect(q('[data-testid="welcome-report-ready"]')).not.toBeNull();
      expect(q('[data-testid="welcome-report-made-by"]')).toBeNull();
      expect(q('[data-testid="welcome-report-meet"]')).toBeNull();
      expect(document.body.textContent).not.toContain("made this report");
      expect(document.body.textContent).not.toMatch(/Meet (?:Atlas|your assistant)/);
      expect(onmeet).not.toHaveBeenCalled();
      if (component) await unmount(component);
      component = null;
      target?.remove();
    }
  });

  it("with no assistant, shows no made-by line and no Meet button", async () => {
    mountReport({ ready: true, children: briefPage });
    await settle();
    expect(q('[data-testid="welcome-report-ready"]')).not.toBeNull();
    expect(q('[data-testid="welcome-report-made-by"]')).toBeNull();
    expect(q('[data-testid="welcome-report-meet"]')).toBeNull();
    expect(document.body.textContent).not.toContain("make the next one");
  });

  it("a held-back job keeps Connect a model with the AI apps card under it and never says who made the report", async () => {
    const onfix = vi.fn();
    mountReport({
      ready: false,
      madeBy: { name: "Quill", onmeet: vi.fn() },
      aiApps: { detect: async () => null, cli: { claudeCode: true, codex: false } },
      blocked: { message: "Quill has no model connected on this computer.", label: "Connect a model", onfix },
      children: briefPage,
    });
    await settle();
    const apps = q('[data-testid="connect-ai-apps-card"]');
    const held = q('[data-testid="welcome-report-blocked"]');
    expect(apps).not.toBeNull();
    expect(held).not.toBeNull();
    expect(held!.compareDocumentPosition(apps!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q('[data-testid="welcome-report-connect"]')?.contains(apps)).toBe(true);
    expect(q('[data-testid="connect-ai-app-claude-code"]')).not.toBeNull();
    expect(q('[data-testid="welcome-report-made-by"]')).toBeNull();
    expect(q('[data-testid="welcome-report-meet"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="welcome-report-blocked-fix"]')!.click();
    expect(onfix).toHaveBeenCalledTimes(1);
  });

  it("after the rise, the brief is the first view and its one thing hands the prompt to a session", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const onlaunch = vi.fn(async () => null);
    const onopenmeetings = vi.fn();
    component = mount(ReportWithBrief, {
      target,
      props: {
        input: welcomeRiseBriefInput(),
        welcome: parseWelcome(TOUR), firstViewData: { welcome: TOUR, importReport: null },
        onopenmeetings,
        actions: { destinations: { assistantName: "Atlas", claudeCode: true, codex: false }, onassistant: vi.fn(async () => null) },
        report: { aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false } } },
        onlaunch,
      },
    });
    await settle();
    const ready = q('[data-testid="welcome-report-ready"]')!;
    const grid = q('[data-testid="first-view-grid"]')!;
    expect(grid).not.toBeNull();
    expect(ready.contains(grid)).toBe(true);
    expect(q('[data-testid="brief-greeting"]')?.textContent).toBe("Good morning, Alex.");
    expect([...grid.querySelectorAll<HTMLElement>(":scope > [data-widget]")].map((el) => el.dataset.widget).slice(0, 3)).toEqual(["sunrise", "connect", "oneThing"]);
    // The old welcome edition and the review catalogue are gone from the welcome page.
    expect(q('[data-testid="welcome-edition"]')).toBeNull();
    expect(q('[data-testid="welcome-report-ready"] [data-testid="brief-action-cards"]')).toBeNull();
    expect(ready.textContent).not.toMatch(/\.svelte|apps\/desktop|launch_prompt/);
    expect(onopenmeetings).not.toHaveBeenCalled();

    const start = q<HTMLButtonElement>('[data-testid="first-view-one-thing"] [data-testid="brief-start"]')!;
    expect(start).not.toBeNull();
    start.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    // The welcome action's own prompt, in the engine the brief starts in.
    expect(onlaunch.mock.calls[0]).toEqual(["claude", TOUR_PROMPT]);
    expect(q('[data-testid="first-view-one-thing"] .note[role="status"]')?.textContent).toBe("Started in Claude.");
  });

  it("the reveal's count stays on the rise, and the first view does not repeat a run-stats line", async () => {
    const companies = [
      { id: "northstar", name: "Northstar" },
      { id: "fieldwork", name: "Fieldwork" },
    ];
    const sources = welcomeRiseSources(companies);
    // The reveal is frozen on its last frame, so the count on screen is known.
    const elapsed = riseRevealAt(sources.length - 1) + 0.35;
    const ended = riseFrame(elapsed, sources).countText;
    expect(ended).toMatch(/sessions? read/);
    const input = { ...welcomeRiseBriefInput(), runStats: null };
    const report = { aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false } }, companies, elapsed };

    const props = $state({ ready: false });
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ReportWithBrief, {
      target,
      props: {
        input,
        report,
        welcome: parseWelcome(core.showcase_personal), firstViewData: { welcome: core.showcase_personal, importReport: null },
        get ready() {
          return props.ready;
        },
      },
    });
    await settle();
    expect(q('[data-testid="brief-rise"]')).not.toBeNull();
    const shown = q('[data-testid="brief-rise-count"]')?.textContent;
    expect(shown).toBe(ended);
    props.ready = true;
    await settle();
    // The first view counts from the welcome itself, under the greeting, once.
    expect(q('[data-testid="first-view-grid"]')).not.toBeNull();
    expect(q('[data-testid="welcome-edition-run"]')).toBeNull();
    expect(q('[data-testid="welcome-report-ready"]')?.textContent).not.toContain(shown!);
    expect(q('[data-testid="first-view-count-line"]')?.textContent).toMatch(/^196 sessions over 41 days/);
    expect(document.querySelectorAll('[data-testid="first-view-count-line"]')).toHaveLength(1);
  });

  it("review mode (Shift+A) swaps the first view for the full catalogue, and back", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(ReportWithBrief, {
      target,
      props: { input: welcomeRiseBriefInput(), welcome: parseWelcome(core.showcase_personal), firstViewData: { welcome: core.showcase_personal, importReport: null }, report: { aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false } } } },
    });
    await settle();
    expect(q('[data-testid="first-view-grid"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    await settle();
    expect(q('[data-testid="first-view-grid"]')).toBeNull();
    expect(q('[data-testid="brief-review"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    await settle();
    expect(q('[data-testid="first-view-grid"]')).not.toBeNull();
    expect(q('[data-testid="brief-review"]')).toBeNull();
  });

  it("the first view launches in the engine the person saved, and a second click while it starts does nothing", async () => {
    localStorage.setItem("hq.brief.engine", "codex");
    target = document.createElement("div");
    document.body.appendChild(target);
    let finish: (v: string | null) => void = () => undefined;
    const onlaunch = vi.fn(() => new Promise<string | null>((r) => (finish = r)));
    try {
      component = mount(ReportWithBrief, {
        target,
        props: { input: welcomeRiseBriefInput(), welcome: parseWelcome(TOUR), firstViewData: { welcome: TOUR, importReport: null }, report: { aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: true } } }, onlaunch },
      });
      await settle();
      const start = q<HTMLButtonElement>('[data-testid="first-view-one-thing"] [data-testid="brief-start"]')!;
      start.click();
      await settle();
      expect(start.disabled).toBe(true);
      start.click();
      await settle();
      expect(onlaunch).toHaveBeenCalledTimes(1);
      expect((onlaunch.mock.calls[0] as unknown as [string])[0]).toBe("codex");
      finish(null);
      await settle();
      expect(start.disabled).toBe(false);
      expect(q('[data-testid="first-view-one-thing"] .note[role="status"]')?.textContent).toBe("Started in Codex.");
    } finally {
      localStorage.removeItem("hq.brief.engine");
    }
  });

  it("a launch that throws keeps the first view's start button so the person can try again", async () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    const onlaunch = vi.fn(async (): Promise<string | null> => {
      throw new Error("bridge down");
    });
    component = mount(ReportWithBrief, {
      target,
      props: { input: welcomeRiseBriefInput(), welcome: parseWelcome(TOUR), firstViewData: { welcome: TOUR, importReport: null }, report: { aiApps: { detect: async () => SCAN, cli: { claudeCode: true, codex: false } } }, onlaunch },
    });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-view-one-thing"] [data-testid="brief-start"]')!.click();
    await settle();
    expect(onlaunch).toHaveBeenCalledTimes(1);
    const start = q<HTMLButtonElement>('[data-testid="first-view-one-thing"] [data-testid="brief-start"]');
    expect(start).not.toBeNull();
    expect(start!.disabled).toBe(false);
    expect(q('[data-testid="first-view-one-thing"] .note[role="status"]')).toBeNull();
  });
});
