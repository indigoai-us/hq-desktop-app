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
import { FIRST_RUN_SIGNIN_COPY, type FirstRunSignInHost } from "./first-run-signin.js";

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
  signin?: FirstRunSignInHost | null;
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
      signin: opts.signin ?? null,
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
    expect(text("first-run-decision-lead")).toMatch(/^We noticed you use Codex the most on this \w+, \d+ sessions so far\. Want to keep working there\?$/);
    expect(text("first-run-decision-primary")).toBe("Continue in Codex");
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
    };
    return { signin, runs };
  }
  const SIGNED_OUT = { claude: true, codex: false };

  it("a signed-in tool continues with no sign-in step", async () => {
    const { signin } = fakeSignIn(true);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(signin.signedIn).toHaveBeenCalledWith("codex");
    expect(signin.run).not.toHaveBeenCalled();
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
    expect(timing.some((line) => line.includes("kind=signin"))).toBe(false);
  });

  it("a tool the stored logins already show as ready skips even the check", async () => {
    const { signin } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: { claude: true, codex: true } });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(signin.signedIn).not.toHaveBeenCalled();
    expect(signin.run).not.toHaveBeenCalled();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
  });

  it("signed out, Continue in Codex shows the waiting state, then goes on once the sign-in connects", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(text("first-run-signin-waiting")).toBe("Signing in to Claude Code…");
    runs[0]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("claude");
  });

  it("a failed sign-in says so and offers Retry and Skip for now; Retry runs it again", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(byId("first-run-signin-failed")).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("Skip for now goes on without the sign-in and stops the wait", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers, timing } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(runs[0]!.cancelled()).toBe(false);
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(runs[0]!.cancelled()).toBe(true);
    expect(signin.cancel).toHaveBeenCalledTimes(1);
    expect(signin.cancel).toHaveBeenCalledWith("codex");
    expect(byId("first-run-signin-waiting")).toBeNull();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
    expect(timing).toContain("kind=signin event=skipped tool=codex");

    // A sign-in that lands after Skip changes nothing.
    runs[0]!.finish(true);
    await settle();
    expect(handlers.oncontinueintool).toHaveBeenCalledTimes(1);
    expect(timing.some((line) => line.includes("event=done"))).toBe(false);
  });

  it("Skip after a failed sign-in has nothing running to stop", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    runs[0]!.finish(false);
    await settle();
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(signin.cancel).not.toHaveBeenCalled();
    expect(handlers.oncontinueintool).toHaveBeenCalledWith("codex");
  });

  it("leaving the screen while it waits stops the sign-in and goes on to nothing", async () => {
    const { signin, runs } = fakeSignIn(false);
    const { handlers } = render({ signin, installed: SIGNED_OUT });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
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
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    byId<HTMLButtonElement>("first-run-signin-skip")!.click();
    await settle();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "codex");
  });

  it("with no detected tool, the name path has no sign-in step", async () => {
    const { signin } = fakeSignIn(false);
    const { handlers } = render({ signin, scanTools: [], installed: {} });
    await waitForDecision();
    byId<HTMLButtonElement>("first-run-decision-primary")!.click();
    await settle();
    expect(signin.signedIn).not.toHaveBeenCalled();
    expect(handlers.onconfirmname).toHaveBeenCalledWith("Pickles", "claude");
  });
});
