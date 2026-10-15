// @vitest-environment happy-dom

/**
 * US-007: after the blocking install, the tree fills in and then one question
 * shows: continue in the coding tool used most here, or name the HQ bot. A
 * person with no coding tool sees only the bot path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstRunDecisionTakeover from "./FirstRunDecisionTakeover.svelte";
import {
  FIRST_RUN_COPY,
  FIRST_RUN_DECISION_COPY,
  type FirstRunCreation,
  type FirstRunFlowScreen,
  type FirstRunToolUsage,
} from "./visual-first-run.js";
import type { ImportScanEnd, ImportScanHost } from "./knowledge-tree/import-runner.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

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
  oncontinueintool?: (runtime: string) => void | Promise<void>;
  onretry?: () => void | Promise<void>;
}

function render(opts: Opts = {}) {
  const timing: string[] = [];
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(opts.onretry ?? (() => undefined)),
    ontalk: vi.fn(),
    oncontinueintool: vi.fn(opts.oncontinueintool ?? (() => undefined)),
    oncontinueinchat: vi.fn(),
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
  host?.remove();
  vi.restoreAllMocks();
});

describe("FirstRunDecisionTakeover", () => {
  it("names the most used tool, with the bot as the alternative", async () => {
    render();
    await waitForDecision();
    expect(byId("first-run-decision")?.getAttribute("data-path")).toBe("tool");
    expect(text("first-run-decision-question")).toBe(FIRST_RUN_DECISION_COPY.toolQuestion);
    expect(text("first-run-decision-lead")).toMatch(/^You use Codex most on this /);
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
    expect(text("first-run-decision-other")).toBe("Name your HQ bot instead");
    expect(byId("first-run-bot-name")).toBeNull();
    expect(document.querySelectorAll('[data-testid="first-run-decision-primary"]')).toHaveLength(1);
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

  it("with no scan counts, names the first installed tool", async () => {
    render({ scanTools: null, installed: { claude: true, codex: true } });
    await waitForDecision();
    expect(text("first-run-decision-primary")).toBe("Continue in Claude Code");
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

  it("continue in the tool passes its runtime, shows a pending state at once and ignores a second press", async () => {
    let release: () => void = () => undefined;
    const { handlers } = render({
      oncontinueintool: () => new Promise<void>((resolve) => (release = resolve)),
    });
    await waitForDecision();
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    primary.click();
    await settle();
    expect(primary.disabled).toBe(true);
    expect(primary.getAttribute("aria-busy")).toBe("true");
    expect(primary.textContent?.trim()).toBe(FIRST_RUN_COPY.opening);
    expect(byId<HTMLButtonElement>("first-run-decision-other")!.disabled).toBe(true);
    primary.click();
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(1);
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
    release();
    await settle();
    expect(primary.disabled).toBe(false);
  });

  it("logs a failed tool handoff and frees the button", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render({ oncontinueintool: async () => Promise.reject(new Error("no launch")) });
    await waitForDecision();
    const primary = byId<HTMLButtonElement>("first-run-decision-primary")!;
    primary.click();
    await settle();
    expect(warn).toHaveBeenCalled();
    expect(primary.disabled).toBe(false);
  });

  it("confirming a name starts the bot with the named tool's runtime and moves to done", async () => {
    const { handlers } = render({ initialChoseBot: true });
    await waitForDecision();
    const input = byId<HTMLInputElement>("first-run-bot-name")!;
    input.value = "  Juniper  ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(handlers.onconfirmname).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(q('[role="alert"]')).toBeTruthy();
  });

  it("with no tool, the bot starts on the first setup runtime", async () => {
    const { handlers } = render({ scanTools: [], installed: {} });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
