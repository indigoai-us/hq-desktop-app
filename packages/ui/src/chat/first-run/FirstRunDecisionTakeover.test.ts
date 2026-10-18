// @vitest-environment happy-dom

/**
 * US-007: after the blocking install, the tree fills in and then one question
 * shows: continue in the coding tool used most here, or name the HQ bot. A
 * person with no coding tool sees only the bot path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { createClassComponent } from "svelte/legacy";

import FirstRunDecisionTakeover from "./FirstRunDecisionTakeover.svelte";
import {
  FIRST_RUN_COPY,
  FIRST_RUN_DECISION_COPY,
  type FirstRunCreation,
  type FirstRunFlowScreen,
  type FirstRunToolUsage,
} from "./visual-first-run.js";
import type { ImportScanEnd, ImportScanHost } from "./knowledge-tree/import-runner.js";
import { FIRST_RUN_SIGNIN_COPY, type FirstRunSignInHost } from "./first-run-signin.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let legacy: { $set: (props: Record<string, unknown>) => void; $destroy: () => void } | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
const q = <T extends Element = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);
const byId = <T extends Element = HTMLElement>(id: string): T | null => q<T>(`[data-testid="${id}"]`);
const text = (id: string) => byId(id)?.textContent?.trim() ?? null;

const NOW = 1_760_000_000_000;
const CODEX_MOST: FirstRunToolUsage[] = [
  { tool: "claude-code", sessions_total: 4, sessions_last_30d: 1, last_active_at: NOW - 5000 },
  { tool: "codex", sessions_total: 9, sessions_last_30d: 6, last_active_at: NOW },
];
const READY: FirstRunCreation = { state: "ready", name: "Pickles", bot: { agentUid: "agt_1", handle: "setup" } };

function pendingImportHost() {
  const runs: Array<{ emit: (raw: unknown) => void; end: (status: ImportScanEnd["status"]) => void }> = [];
  const importHost: ImportScanHost = {
    run: vi.fn(
      (_scanId: string, emit: (raw: unknown) => void) =>
        new Promise<ImportScanEnd>((resolve) => runs.push({ emit, end: (status) => resolve({ status }) })),
    ),
    cancel: vi.fn(),
  };
  return { importHost, runs };
}

interface Opts {
  scanTools?: FirstRunToolUsage[] | null;
  installed?: Record<string, boolean> | null;
  creation?: FirstRunCreation;
  importHost?: ImportScanHost | null;
  initialScreen?: FirstRunFlowScreen;
  initialChoseBot?: boolean;
  oncontinueintool?: (
    runtime: string,
    choice: { enableHqAnywhere: boolean },
  ) => string | null | void | Promise<string | null | void>;
  onretry?: () => void | Promise<void>;
  signin?: FirstRunSignInHost | null;
  /** Default true so the callout is on screen unless a test turns it off. */
  hqAnywhereFlag?: boolean | null;
  /** Default true: an installer exists, matching a callout that can install. */
  canInstallHq?: boolean;
}

function render(opts: Opts = {}) {
  const timing: string[] = [];
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(opts.onretry ?? (() => undefined)),
    ontalk: vi.fn(),
    oncontinueintool: vi.fn(opts.oncontinueintool ?? (() => undefined)),
    oncontinueinchat: vi.fn(),
    onskipintool: vi.fn(),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunDecisionTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      importHost: opts.importHost ?? null,
      scanTools: opts.scanTools === undefined ? CODEX_MOST : opts.scanTools,
      installed: opts.installed === undefined ? { claude: true, codex: true } : opts.installed,
      creation: opts.creation ?? { state: "idle" },
      initialScreen: opts.initialScreen ?? "decision",
      initialChoseBot: opts.initialChoseBot ?? false,
      reducedMotion: true,
      timingLog: (line: string) => timing.push(line),
      signin: opts.signin ?? null,
      hqAnywhereFlag: opts.hqAnywhereFlag === undefined ? true : opts.hqAnywhereFlag,
      canInstallHq: opts.canInstallHq ?? true,
      ...handlers,
    },
  });
  return { handlers, timing };
}

/** The decision renders inside the tree scene, which loads lazily. */
async function waitForDecision(): Promise<void> {
  await vi.waitFor(() => expect(byId("first-run-decision")).toBeTruthy(), { timeout: 3000 });
  await settle();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  legacy?.$destroy();
  legacy = null;
  host?.remove();
  vi.restoreAllMocks();
});

/** One Continue. On the decision screen this opens the callout and stops. */
async function showCalloutStep(): Promise<void> {
  byId<HTMLButtonElement>("first-run-decision-primary")!.click();
  await settle();
}

/** Default flag is on, so the first Continue opens the callout. A second press, with no Enable, is the handoff. */
async function continuePastCallout(): Promise<void> {
  await showCalloutStep();
  if (byId("first-run-anywhere-slot")) {
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
  }
}

describe("FirstRunDecisionTakeover", () => {
  it("names the most used tool, with the bot as the alternative", async () => {
    render();
    await waitForDecision();
    expect(byId("first-run-decision")?.getAttribute("data-path")).toBe("tool");
    expect(text("first-run-decision-question")).toBe(FIRST_RUN_DECISION_COPY.toolQuestion);
    expect(text("first-run-decision-lead")).toMatch(/^We noticed you use Codex the most on this \w+, \d+ sessions so far\. Want to keep working there\?$/);
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(byId("first-run-decision-primary")?.getAttribute("aria-describedby")).toBeNull();
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("Enable HQ Anywhere");
    expect(byId("first-run-decision-install-note")).toBeNull();
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("This also installs HQ");
    expect(text("first-run-decision-other")).toBe("Name Your Assistant");
    expect(byId("first-run-bot-name")).toBeNull();
    expect(document.querySelectorAll('[data-testid="first-run-decision-primary"]')).toHaveLength(1);
  });

  it("presents the tool and naming the assistant as two equal buttons (owner, 2026-10-15)", async () => {
    render();
    await waitForDecision();
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    const other = byId<HTMLButtonElement>("first-run-decision-other")!;
    expect(other.className).toBe(primary.className);
    expect(other.parentElement).toBe(primary.parentElement);
    expect(primary.parentElement?.classList.contains("single")).toBe(false);
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("instead");
  });

  it("shows no company, Bring it in, Coding tools or Finish with defaults screen", async () => {
    render();
    await waitForDecision();
    const shown = byId("first-run-takeover")?.textContent ?? "";
    for (const gone of ["Finish with defaults", "Bring it in", "Coding tools", "Bring in your context"]) {
      expect(shown).not.toContain(gone);
    }
    expect(byId("first-run-team-personal")).toBeNull();
    expect(byId("new-bot-progress")).toBeNull();
  });

  it("switches to the bot path and back", async () => {
    render();
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-other")!.click();
    await settle();
    expect(byId("first-run-decision")?.getAttribute("data-path")).toBe("bot");
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("Enable HQ Anywhere");
    expect(text("first-run-decision-question")).toBe(FIRST_RUN_DECISION_COPY.botQuestion);
    expect(byId<HTMLInputElement>("first-run-bot-name")?.value).toBe("Pickles");
    expect(text("first-run-decision-primary")).toBe("Continue");
    expect(text("first-run-decision-other")).toBe("Continue in Codex instead");
    byId<HTMLButtonElement>("first-run-decision-other")!.click();
    await settle();
    expect(byId("first-run-decision")?.getAttribute("data-path")).toBe("tool");
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
  });

  it("with no coding tool, offers only the bot path", async () => {
    render({ scanTools: [], installed: { claude: false, codex: false } });
    await waitForDecision();
    expect(byId("first-run-decision")?.getAttribute("data-path")).toBe("bot");
    expect(text("first-run-decision-question")).toBe(FIRST_RUN_DECISION_COPY.botQuestion);
    expect(byId("first-run-bot-name")).toBeTruthy();
    expect(byId("first-run-decision-other")).toBeNull();
    expect(byId("first-run-decision-lead")).toBeNull();
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("Continue in");
  });

  it("hides the callout when HQ Anywhere is off, when no installer exists, and when the tool is Grok", async () => {
    const off = render({ hqAnywhereFlag: false });
    await waitForDecision();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(byId("first-run-decision-primary")?.getAttribute("aria-describedby")).toBeNull();
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("Enable HQ Anywhere");
    await continuePastCallout();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(off.handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    await unmount(component!);
    component = null;
    host?.remove();

    const noInstaller = render({ hqAnywhereFlag: true, canInstallHq: false });
    await waitForDecision();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await continuePastCallout();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(noInstaller.handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    await unmount(component!);
    component = null;
    host?.remove();

    const grok = render({ hqAnywhereFlag: true, scanTools: [], installed: { claude: false, codex: false, grok: true } });
    await waitForDecision();
    expect(text("first-run-decision-primary")).toBe("Continue in Grok");
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await continuePastCallout();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(grok.handlers.oncontinueintool).toHaveBeenCalledWith("grok", { enableHqAnywhere: false });
  });

  it("with no scan counts, names the first installed tool and shows the callout only after Continue", async () => {
    const { handlers } = render({ scanTools: null, installed: { claude: true, codex: true } });
    await waitForDecision();
    expect(text("first-run-decision-primary")).toBe("Continue in Claude Code");
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await showCalloutStep();
    expect(text("first-run-anywhere-slot")).toContain(FIRST_RUN_DECISION_COPY.anywhereBody("Claude Code"));
    expect(byId("first-run-decision-question")).toBeNull();
    expect(byId("first-run-decision-other")).toBeNull();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
  });

  it("shows the callout when the flag is unread, and an explicit false skips it", async () => {
    const oncontinueintool = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    legacy = createClassComponent({
      component: FirstRunDecisionTakeover,
      target: host,
      props: {
        initialName: "Pickles",
        importHost: null,
        scanTools: CODEX_MOST,
        installed: { claude: true, codex: true },
        creation: { state: "idle" },
        initialScreen: "decision",
        initialChoseBot: false,
        reducedMotion: true,
        hqAnywhereFlag: null,
        canInstallHq: true,
        onconfirmname: vi.fn(),
        onretry: vi.fn(),
        ontalk: vi.fn(),
        oncontinueintool,
        oncontinueinchat: vi.fn(),
        onskipintool: vi.fn(),
      },
    });
    await waitForDecision();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await showCalloutStep();
    expect(text("first-run-anywhere-slot")).toContain("Enable HQ Anywhere");
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
    expect(text("first-run-decision-primary")).not.toContain("Setting up");
    expect(oncontinueintool).not.toHaveBeenCalled();
    legacy.$destroy();
    legacy = null;
    host?.remove();

    const skipped = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    legacy = createClassComponent({
      component: FirstRunDecisionTakeover,
      target: host,
      props: {
        initialName: "Pickles",
        importHost: null,
        scanTools: CODEX_MOST,
        installed: { claude: true, codex: true },
        creation: { state: "idle" },
        initialScreen: "decision",
        initialChoseBot: false,
        reducedMotion: true,
        hqAnywhereFlag: false,
        canInstallHq: true,
        onconfirmname: vi.fn(),
        onretry: vi.fn(),
        ontalk: vi.fn(),
        oncontinueintool: skipped,
        oncontinueinchat: vi.fn(),
        onskipintool: vi.fn(),
      },
    });
    await waitForDecision();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await continuePastCallout();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    expect(skipped).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
  });

  it("Enable, Not now and Undo, and Continue installs only after Enable", async () => {
    const { handlers } = render();
    await waitForDecision();
    expect(byId("first-run-anywhere-slot")).toBeNull();
    await showCalloutStep();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    const enable = byId<HTMLButtonElement>("first-run-anywhere-enable")!;
    const notNow = byId<HTMLButtonElement>("first-run-anywhere-not-now")!;
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    expect(enable.classList.contains("new-bot-create-next")).toBe(true);
    expect(enable.classList.contains("new-bot-create-submit")).toBe(false);
    expect(primary.classList.contains("new-bot-create-submit")).toBe(true);
    expect(byId("first-run-anywhere-slot")?.getAttribute("data-state")).toBe("unset");
    expect(byId("first-run-anywhere-slot")?.closest(".fr-decision-head")).toBeTruthy();
    expect(primary.closest(".fr-decision-head")).toBeNull();
    expect(byId("first-run-anywhere-slot")!.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(byId("first-run-decision-question")).toBeNull();
    expect(byId("first-run-decision-other")).toBeNull();
    expect(primary.getAttribute("aria-describedby")).toBe("first-run-anywhere-callout");

    enable.click();
    await settle();
    expect(text("first-run-anywhere-on")).toContain("HQ Anywhere is on. Continue sets it up.");
    expect(text("first-run-anywhere-undo")).toBe("Undo");
    byId<HTMLButtonElement>("first-run-anywhere-undo")!.click();
    await settle();
    expect(byId("first-run-anywhere-enable")).toBeTruthy();

    byId<HTMLButtonElement>("first-run-anywhere-not-now")!.click();
    await settle();
    expect(text("first-run-anywhere-off")).toBe("HQ Anywhere is off. Turn it on later in Settings.");
    expect(byId("first-run-anywhere-undo")).toBeNull();
    expect(byId("first-run-anywhere-enable")).toBeNull();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });

    await unmount(component!);
    component = null;
    host?.remove();
    const again = render();
    await waitForDecision();
    await showCalloutStep();
    byId<HTMLButtonElement>("first-run-anywhere-enable")!.click();
    await settle();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(again.handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: true });
    expect(notNow).toBeTruthy();
  });

  it("waits for the scan before asking", async () => {
    const { importHost, runs } = pendingImportHost();
    render({ importHost });
    await waitForDecision();
    expect(text("first-run-decision-scanning")).toBe(FIRST_RUN_DECISION_COPY.scanning);
    expect(byId("first-run-decision-primary")).toBeNull();
    expect(runs).toHaveLength(1);
    runs[0].end("failed");
    await vi.waitFor(() => expect(byId("first-run-decision-scanning")).toBeNull(), { timeout: 3000 });
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
  });

  it("continue in the tool passes its runtime, stays Continue in <tool> while busy and ignores a second press", async () => {
    let release: () => void = () => undefined;
    const { handlers } = render({
      oncontinueintool: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(byId("first-run-anywhere-slot")).toBeTruthy();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    primary.click();
    await settle();
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute("aria-busy")).toBe("true");
    expect(primary.textContent?.trim()).toBe("Continue in Codex");
    expect(byId("first-run-decision-other")).toBeNull();
    primary.click();
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(1);
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    release();
    await settle();
    expect(primary.disabled).toBe(false);
  });

  it("logs a failed tool handoff and frees the button", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render({ oncontinueintool: async () => Promise.reject(new Error("no launch")) });
    await waitForDecision();
    await continuePastCallout();
    expect(warn).toHaveBeenCalled();
    expect(byId<HTMLButtonElement>("first-run-decision-primary")!.disabled).toBe(false);
    // A thrown error shows a fixed sentence, never the raw error text.
    expect(text("first-run-decision-error")).toBe("Could not continue to the desktop. Try again.");
    expect(text("first-run-decision-primary")).toBe(FIRST_RUN_COPY.retry);
    expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("no launch");
  });

  it("a Retry after a thrown handoff reads Retry while it runs, never Continue in <tool>", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    let release: () => void = () => undefined;
    render({
      oncontinueintool: async () => {
        calls += 1;
        if (calls === 1) throw new Error("no launch");
        await new Promise<void>((resolve) => (release = resolve));
      },
    });
    await waitForDecision();
    await continuePastCallout();
    await vi.waitFor(() => expect(text("first-run-decision-primary")).toBe(FIRST_RUN_COPY.retry));
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    expect(calls).toBe(2);
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute("aria-busy")).toBe("true");
    expect(primary.textContent?.trim()).toBe(FIRST_RUN_COPY.retry);
    expect(primary.textContent ?? "").not.toContain("Continue in");
    release();
    await settle();
    expect(primary.disabled).toBe(false);
    expect(primary.textContent?.trim()).toBe("Continue in Codex");
  });

  it("shows the sentence the host returns when the tool does not open, offers Retry, and clears it on the next press", async () => {
    const replies: Array<string | null> = ["Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI).", null];
    let release: () => void = () => undefined;
    const { handlers } = render({
      oncontinueintool: vi.fn(async () => {
        const reply = replies.shift() ?? null;
        if (reply === null) await new Promise<void>((resolve) => (release = resolve));
        return reply;
      }),
    });
    await waitForDecision();
    expect(byId("first-run-decision-error")).toBeNull();
    await continuePastCallout();
    await vi.waitFor(() => expect(byId("first-run-decision-error")).toBeTruthy());
    const error = byId("first-run-decision-error")!;
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI).");
    expect(text("first-run-decision-primary")).toBe(FIRST_RUN_COPY.retry);
    expect(byId("first-run-decision-other")).toBeNull();
    expect(byId("first-run-anywhere-slot")).toBeTruthy();

    await continuePastCallout();
    expect(byId("first-run-decision-error")).toBeNull();
    // The retry's own press keeps reading Retry while it runs (Shepherd, PR 1642).
    expect(text("first-run-decision-primary")).toBe(FIRST_RUN_COPY.retry);
    expect(byId<HTMLButtonElement>("first-run-decision-primary")!.disabled).toBe(true);
    release();
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(2);
    expect(byId("first-run-decision-error")).toBeNull();
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
  });

  it("confirming a name starts the bot with the named tool's runtime and moves to done", async () => {
    const { handlers } = render({ initialChoseBot: true });
    await waitForDecision();
    const input = byId<HTMLInputElement>("first-run-bot-name")!;
    input.value = "  Juniper  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await continuePastCallout();
    expect(handlers.onconfirmname).toHaveBeenCalledTimes(1);
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Juniper", "codex");
    expect(byId("first-run-takeover")?.getAttribute("data-step")).toBe("done");
  });

  it("an invalid name stays on the question and says why", async () => {
    const { handlers } = render({ initialChoseBot: true });
    await waitForDecision();
    const input = byId<HTMLInputElement>("first-run-bot-name")!;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    await continuePastCallout();
    expect(handlers.onconfirmname).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(q('[role="alert"]')).toBeTruthy();
  });

  it("with no tool, the bot starts on the first setup runtime", async () => {
    const { handlers } = render({ scanTools: [], installed: {} });
    await waitForDecision();
    await continuePastCallout();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "claude");
  });

  it("done shows the bot getting ready, then talk", async () => {
    render({ initialScreen: "done", creation: { state: "creating", name: "Pickles" } });
    await waitForDecision();
    const talk = byId<HTMLButtonElement>("first-run-talk")!;
    expect(talk.textContent?.trim()).toBe("Getting Pickles ready…");
    expect(talk.disabled).toBe(true);
    expect(talk.getAttribute("aria-busy")).toBe("true");
  });

  it("done with a ready bot opens its chat once", async () => {
    const { handlers } = render({ initialScreen: "done", creation: READY });
    await waitForDecision();
    const talk = byId<HTMLButtonElement>("first-run-talk")!;
    expect(talk.textContent?.trim()).toBe("Open HQ");
    expect(talk.disabled).toBe(false);
    talk.click();
    talk.click();
    await settle();
    expect(handlers.ontalk).toHaveBeenCalledTimes(1);
  });

  it("a failed create shows the reason and one retry", async () => {
    let release: () => void = () => undefined;
    const { handlers } = render({
      initialScreen: "done",
      creation: { state: "failed", name: "Pickles", reason: "Couldn't create Pickles. Try again." },
      onretry: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await waitForDecision();
    expect(text("first-run-done-failed")).toBe("Couldn't create Pickles. Try again.");
    const retry = byId<HTMLButtonElement>("first-run-done-retry")!;
    expect(retry.textContent?.trim()).toBe(FIRST_RUN_COPY.retry);
    retry.click();
    await settle();
    expect(retry.disabled).toBe(true);
    expect(retry.textContent?.trim()).toBe(FIRST_RUN_COPY.retrying);
    retry.click();
    await settle();
    expect(handlers.onretry).toHaveBeenCalledTimes(1);
    release();
  });

  it("writes enter and leave timing lines with id decision", async () => {
    const { timing } = render({ initialChoseBot: true });
    await waitForDecision();
    expect(timing.some((line) => /kind=screen event=enter surface=takeover id=decision\b/.test(line))).toBe(true);
    await continuePastCallout();
    expect(
      timing.some((line) => /kind=screen event=leave surface=takeover id=decision elapsed_ms=\d+/.test(line)),
    ).toBe(true);
    expect(timing.some((line) => /event=enter surface=takeover id=done\b/.test(line))).toBe(true);
  });

  it("Escape does not close the takeover", async () => {
    render();
    await waitForDecision();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(escape);
    await settle();
    expect(escape.defaultPrevented).toBe(true);
    expect(byId("first-run-takeover")).toBeTruthy();
    expect(byId("first-run-decision")?.getAttribute("data-screen")).toBe("decision");
  });
});

/**
 * The detected tool's sign-in (owner, 2026-10-16: "Just have them sign in
 * after we identify what they use most often"). Continue in <tool> and the
 * name path wait on it; Skip for now goes on without it.
 */
describe("FirstRunDecisionTakeover sign-in", () => {
  function fakeSignIn(signedIn = false) {
    const runs: Array<{ runtime: string; cancelled: () => boolean; finish: (ok: boolean) => void }> = [];
    const signin: FirstRunSignInHost = {
      signedIn: vi.fn(async () => signedIn),
      run: vi.fn(
        (runtime: string, opts: { cancelled: () => boolean }) =>
          new Promise<boolean>((resolve) => runs.push({ runtime, cancelled: opts.cancelled, finish: resolve })),
      ),
      cancel: vi.fn(async () => undefined),
      focus: vi.fn(async () => undefined),
    };
    return { signin, runs };
  }
  const SIGNED_OUT = { claude: true, codex: false };

  /**
   * The browser sign-in leaves the browser in front of HQ, so the person
   * never saw the Daily Brief (test Mac, 2026-10-16). Each way the step ends
   * brings HQ back; the wait itself never does.
   */
  describe("brings HQ back to the front when the step ends", () => {
    async function pressContinue(signin: FirstRunSignInHost) {
      const result = render({ signin, installed: SIGNED_OUT });
      await waitForDecision();
      await continuePastCallout();
      return result;
    }

    it("never while the browser sign-in waits", async () => {
      const { signin } = fakeSignIn(false);
      await pressContinue(signin);
      expect(byId("first-run-signin-waiting")).toBeTruthy();
      expect(signin.focus).not.toHaveBeenCalled();
    });

    it("once the sign-in is done", async () => {
      const { signin, runs } = fakeSignIn(false);
      const { handlers } = await pressContinue(signin);
      runs[0]!.finish(true);
      await settle();
      expect(signin.focus).toHaveBeenCalledTimes(1);
      expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    });

    it("once the sign-in failed or timed out", async () => {
      const { signin, runs } = fakeSignIn(false);
      await pressContinue(signin);
      runs[0]!.finish(false);
      await settle();
      expect(byId("first-run-signin-failed")).toBeTruthy();
      expect(signin.focus).toHaveBeenCalledTimes(1);
    });

    it("on Skip for now while it waits, and a late answer does not raise it again", async () => {
      const { signin, runs } = fakeSignIn(false);
      await pressContinue(signin);
      byId<HTMLButtonElement>("first-run-signin-skip")!.click();
      await settle();
      expect(signin.focus).toHaveBeenCalledTimes(1);
      runs[0]!.finish(true);
      await settle();
      expect(signin.focus).toHaveBeenCalledTimes(1);
    });

    it("on Skip for now after a failure, and not again while a retry waits", async () => {
      const { signin, runs } = fakeSignIn(false);
      await pressContinue(signin);
      runs[0]!.finish(false);
      await settle();
      byId<HTMLButtonElement>("first-run-signin-retry")!.click();
      await settle();
      expect(byId("first-run-signin-waiting")).toBeTruthy();
      expect(signin.focus).toHaveBeenCalledTimes(1);
      runs[1]!.finish(false);
      await settle();
      expect(signin.focus).toHaveBeenCalledTimes(2);
      byId<HTMLButtonElement>("first-run-signin-skip")!.click();
      await settle();
      expect(signin.focus).toHaveBeenCalledTimes(3);
    });

    it("not when the tool is already signed in and no browser opened", async () => {
      const { signin } = fakeSignIn(true);
      const { handlers } = await pressContinue(signin);
      expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
      expect(signin.focus).not.toHaveBeenCalled();
    });

    it("a raise that fails is only logged and the first run goes on", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { signin, runs } = fakeSignIn(false);
      signin.focus = vi.fn(async () => {
        throw new Error("window gone");
      });
      const { handlers } = await pressContinue(signin);
      runs[0]!.finish(true);
      await settle();
      expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
      expect(warn).toHaveBeenCalledWith("[first-run] focus after sign-in failed", expect.any(Error));
      warn.mockRestore();
    });
  });

  it("a signed-in tool continues with no sign-in step", async () => {
    const { signin } = fakeSignIn(true);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    expect(signin.signedIn).toHaveBeenCalledWith("codex");
    expect(signin.run).not.toHaveBeenCalled();
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    expect(timing.some((line) => line.includes("kind=signin"))).toBe(false);
  });

  it("a tool the stored logins already show as ready skips even the check", async () => {
    const { signin } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: { claude: true, codex: true } });
    await waitForDecision();
    await continuePastCallout();
    expect(signin.signedIn).not.toHaveBeenCalled();
    expect(signin.run).not.toHaveBeenCalled();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
  });

  it("signed out, Continue in Codex shows the waiting state, then goes on once the sign-in connects", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    expect(runs.map((run) => run.runtime)).toEqual(["codex"]);
    expect(text("first-run-signin-waiting")).toBe("Signing in to Codex…");
    expect(byId("first-run-signin-waiting")?.getAttribute("aria-busy")).toBe("true");
    expect(text("first-run-signin-skip")).toBe("Skip for now");
    expect(byId("first-run-signin-retry")).toBeNull();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    expect(timing).toContain("kind=signin event=start tool=codex");

    runs[0]!.finish(true);
    await settle();
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(1);
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex", { enableHqAnywhere: false });
    expect(timing).toContain("kind=signin event=done tool=codex");
  });

  it("signed out, Continue in Claude Code names Claude Code while it waits", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({
      signin,
      installed: { claude: false, codex: true },
      scanTools: [{ tool: "claude-code", sessions_total: 12, sessions_last_30d: 4, last_active_at: NOW }],
    });
    await waitForDecision();
    expect(text("first-run-decision-primary")).toBe("Continue in Claude Code");
    await continuePastCallout();
    expect(text("first-run-signin-waiting")).toBe("Signing in to Claude Code…");
    runs[0]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("claude", { enableHqAnywhere: false });
  });

  it("a failed sign-in says so and offers Retry and Skip for now; Retry runs it again", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    runs[0]!.finish(false);
    await settle();
    expect(text("first-run-signin-failed")).toBe("Sign-in didn't finish. Try again or skip for now.");
    expect(FIRST_RUN_SIGNIN_COPY.failed).toBe("Sign-in didn't finish. Try again or skip for now.");
    expect(text("first-run-signin-retry")).toBe(FIRST_RUN_COPY.retry);
    expect(text("first-run-signin-skip")).toBe("Skip for now");
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    expect(timing).toContain("kind=signin event=failed tool=codex");

    byId<HTMLButtonElement>("first-run-signin-retry")!.click();
    await settle();
    expect(runs).toHaveLength(2);
    expect(text("first-run-signin-waiting")).toBe("Signing in to Codex…");
    runs[1]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(1);
  });

  it("a sign-in that throws is a failure, never a stuck spinner", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const signin: FirstRunSignInHost = {
      signedIn: vi.fn(async () => false),
      run: vi.fn(async () => {
        throw new Error("host gone");
      }),
    };
    render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    expect(byId("first-run-signin-failed")).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("Skip for now goes on without the sign-in and stops the wait", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    expect(runs[0]!.cancelled()).toBe(false);
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(runs[0]!.cancelled()).toBe(true);
    expect(signin.cancel).toHaveBeenCalledTimes(1);
    expect(signin.cancel).toHaveBeenCalledWith("codex");
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    expect(handlers.onskipintool).toHaveBeenCalledWith("codex");
    expect(timing).toContain("kind=signin event=skipped tool=codex");

    // A sign-in that lands after Skip changes nothing.
    runs[0]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    expect(handlers.onskipintool).toHaveBeenCalledTimes(1);
    expect(timing.some((line) => line.includes("event=done"))).toBe(false);
  });

  it("Skip after a failed sign-in has nothing running to stop", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    runs[0]!.finish(false);
    await settle();
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(signin.cancel).not.toHaveBeenCalled();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
    expect(handlers.onskipintool).toHaveBeenCalledWith("codex");
  });

  it("leaving the screen while it waits stops the sign-in and goes on to nothing", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    await continuePastCallout();
    expect(byId("first-run-signin-waiting")).toBeTruthy();
    await unmount(component!);
    component = null;
    await settle();
    expect(signin.cancel).toHaveBeenCalledTimes(1);
    expect(signin.cancel).toHaveBeenCalledWith("codex");
    expect(runs[0]!.cancelled()).toBe(true);
    runs[0]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).not.toHaveBeenCalled();
  });

  it("the name path signs the detected tool in before it names the assistant", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT, initialChoseBot: true });
    await waitForDecision();
    await continuePastCallout();
    expect(runs.map((run) => run.runtime)).toEqual(["codex"]);
    expect(text("first-run-signin-waiting")).toBe("Signing in to Codex…");
    expect(handlers.onconfirmname).not.toHaveBeenCalled();
    runs[0]!.finish(true);
    await settle();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "codex");
    expect(byId("first-run-takeover")?.getAttribute("data-step")).toBe("done");
  });

  it("Skip for now on the name path still names the assistant", async () => {
    const { signin } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT, initialChoseBot: true });
    await waitForDecision();
    await continuePastCallout();
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "codex");
  });

  it("with no detected tool, the name path has no sign-in step", async () => {
    const { signin } = fakeSignIn(false);
    const { handlers } = render({ signin, scanTools: [], installed: {} });
    await waitForDecision();
    await continuePastCallout();
    expect(signin.signedIn).not.toHaveBeenCalled();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "claude");
  });

  describe("Continue's label while the handoff runs (Shepherd, PR 1642)", () => {
    type Case = {
      name: string;
      opts: Opts;
      choose: "enable" | "later" | null;
      runtime: string;
      enable: boolean;
      busy: string;
    };
    const cases: Case[] = [
      { name: "Not now", opts: {}, choose: "later", runtime: "codex", enable: false, busy: "Continue in Codex" },
      { name: "Continue on the callout with no choice", opts: {}, choose: null, runtime: "codex", enable: false, busy: "Continue in Codex" },
      {
        name: "Grok",
        opts: { hqAnywhereFlag: true, scanTools: [], installed: { claude: false, codex: false, grok: true } },
        choose: null,
        runtime: "grok",
        enable: false,
        busy: "Continue in Grok",
      },
      { name: "the callout killed by its flag", opts: { hqAnywhereFlag: false }, choose: null, runtime: "codex", enable: false, busy: "Continue in Codex" },
      { name: "Enable", opts: {}, choose: "enable", runtime: "codex", enable: true, busy: FIRST_RUN_DECISION_COPY.anywhereTurningOn },
    ];

    for (const c of cases) {
      it(`reads ${JSON.stringify(c.busy)} after Continue with ${c.name}`, async () => {
        let release: () => void = () => undefined;
        const { handlers } = render({
          ...c.opts,
          oncontinueintool: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
        });
        await waitForDecision();
        await showCalloutStep();
        if (byId("first-run-anywhere-slot")) {
          // Continue before the callout shows hands nothing off and keeps its label.
          expect(handlers.oncontinueintool).not.toHaveBeenCalled();
          expect(text("first-run-decision-primary")).toBe("Continue in Codex");
          if (c.choose === "enable") byId<HTMLButtonElement>("first-run-anywhere-enable")!.click();
          if (c.choose === "later") byId<HTMLButtonElement>("first-run-anywhere-not-now")!.click();
          await settle();
          byId<HTMLButtonElement>("first-run-decision-primary")!.click();
          await settle();
        } else {
          expect(c.choose).toBeNull();
        }
        expect(handlers.oncontinueintool).toHaveBeenCalledWith(c.runtime, { enableHqAnywhere: c.enable });
        const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
        expect(primary.getAttribute("aria-busy")).toBe("true");
        expect(primary.textContent?.trim()).toBe(c.busy);
        expect(byId("first-run-takeover")?.textContent ?? "").not.toContain("Setting up");
        release();
        await settle();
        expect(primary.textContent?.trim()).toBe(c.busy === FIRST_RUN_DECISION_COPY.anywhereTurningOn ? "Continue in Codex" : c.busy);
      });
    }

    it("has no Setting up copy anywhere in the decision copy", () => {
      const all = JSON.stringify({ ...FIRST_RUN_DECISION_COPY, ...FIRST_RUN_COPY }) +
        Object.values(FIRST_RUN_DECISION_COPY)
          .map((v: unknown) => (typeof v === "function" ? (v as (...a: unknown[]) => string)("Codex", "Mac", 3) : ""))
          .join(" ");
      expect(all).not.toContain("Setting up");
    });
  });
});
