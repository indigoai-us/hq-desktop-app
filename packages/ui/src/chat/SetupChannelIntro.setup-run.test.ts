// @vitest-environment happy-dom

// #welcome's Run Setup with a host guided-run API: the hero becomes the live
// card, questions are answered through the API (structured for
// questionRequest, plain send for a trailing question), the finish graduates
// boot, the run is resumable after a relaunch, and a not-ready preflight
// falls back to the Sessions page exactly as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import { SetupAgent } from "./setup-agent.svelte";
import {
  SETUP_RUN_SESSION_KEY,
  loadSetupRunRecord,
  saveSetupRunRecord,
  type SetupRunApi,
  type SetupRunEvent,
  type SetupRunPhase,
  type SetupRunSnapshot,
} from "./setup-run";
import { NO_AI_TOOLS } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

const shell = {
  detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS })),
  openClaudeCodeLink: vi.fn(async () => ok(undefined)),
  launchClaudeCode: vi.fn(async () => ok(undefined)),
  launchCodexWorkspace: vi.fn(async () => ok(undefined)),
  launchCliInTerminal: vi.fn(async () => ok(undefined)),
};

const settings = {
  getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }),
};

/** A scripted engine: tests push events and the card follows. */
function fakeSetupRun(overrides: Partial<SetupRunApi> = {}) {
  const listeners = new Map<string, Set<(snapshot: SetupRunSnapshot) => void>>();
  const events = new Map<string, SetupRunEvent[]>();
  const phases = new Map<string, SetupRunPhase>();
  const resolved = new Map<string, string[]>();
  const known = new Set<string>();

  function publish(sessionId: string) {
    const snapshot: SetupRunSnapshot = {
      sessionId,
      events: [...(events.get(sessionId) ?? [])],
      phase: phases.get(sessionId) ?? "working",
      resolvedRequestIds: [...(resolved.get(sessionId) ?? [])],
    };
    for (const cb of listeners.get(sessionId) ?? []) cb(snapshot);
  }

  const api: SetupRunApi & {
    emit(sessionId: string, event: SetupRunEvent, phase?: SetupRunPhase): void;
    exists(sessionId: string): void;
  } = {
    preflight: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => {
      const id = `sess-${known.size + 1}`;
      known.add(id);
      events.set(id, []);
      phases.set(id, "starting");
      return id;
    }),
    attach: vi.fn(async (sessionId: string) => known.has(sessionId)),
    subscribe: vi.fn((sessionId: string, cb: (snapshot: SetupRunSnapshot) => void) => {
      if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
      listeners.get(sessionId)!.add(cb);
      cb({
        sessionId,
        events: [...(events.get(sessionId) ?? [])],
        phase: phases.get(sessionId) ?? "working",
        resolvedRequestIds: [...(resolved.get(sessionId) ?? [])],
      });
      return () => listeners.get(sessionId)?.delete(cb);
    }),
    answerQuestion: vi.fn(async (sessionId: string, requestId: string) => {
      resolved.set(sessionId, [...(resolved.get(sessionId) ?? []), requestId]);
      publish(sessionId);
    }),
    respondPermission: vi.fn(async (sessionId: string, requestId: string) => {
      resolved.set(sessionId, [...(resolved.get(sessionId) ?? []), requestId]);
      publish(sessionId);
    }),
    send: vi.fn(async (sessionId: string, text: string) => {
      events.get(sessionId)?.push({ kind: "userMessage", text });
      phases.set(sessionId, "working");
      publish(sessionId);
    }),
    emit(sessionId, event, phase) {
      events.get(sessionId)?.push(event);
      if (phase) phases.set(sessionId, phase);
      publish(sessionId);
    },
    exists(sessionId) {
      known.add(sessionId);
      if (!events.has(sessionId)) events.set(sessionId, []);
    },
    ...overrides,
  };
  return api;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountIntro(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell, ...props } as never,
  });
  await settle();
}

const q = (sel: string) => host.querySelector<HTMLElement>(sel);
const say = (text: string): SetupRunEvent => ({ kind: "assistantMessage", text });
const turnDone: SetupRunEvent = { kind: "turnDone", status: "success" };

async function clickRunSetup() {
  const button = q('[data-testid="setup-run"]') as HTMLButtonElement | null;
  expect(button).toBeTruthy();
  button!.click();
  await settle();
}

describe("SetupChannelIntro with a Setup Agent", () => {
  it("Run Setup starts the agent's guided run in place; the stepper appears on the hero", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    const onopensessions = vi.fn();
    await mountIntro({ agent, onopensessions });
    expect(q('[data-testid="setup-steps-preview"]')?.querySelectorAll("li").length).toBe(6);
    await clickRunSetup();
    expect(api.start).toHaveBeenCalledWith("/setup --guided");
    expect(onopensessions).not.toHaveBeenCalled();
    const card = q('[data-testid="setup-hero"] [data-testid="setup-run-card"]');
    expect(card?.dataset.setupRunVariant).toBe("steps");
    expect(q('[data-testid="setup-run"]')).toBeNull();
    // The conversation (not the hero) carries the questions.
    expect(q('[data-testid="setup-run-question"]')).toBeNull();
    api.emit("sess-1", say("[hq-setup] step=cloud status=running\nConnecting to HQ Cloud."), "working");
    await settle();
    expect(q('[data-testid="setup-run-step-cloud"]')?.dataset.stepStatus).toBe("running");
  });

  it("hands off to the Sessions draft when the host preflight is not ready", async () => {
    const api = fakeSetupRun({ preflight: vi.fn(async () => "needs-sessions-page" as const) });
    const agent = new SetupAgent(api);
    const onopensessions = vi.fn();
    await mountIntro({ agent, onopensessions });
    await clickRunSetup();
    expect(api.start).not.toHaveBeenCalled();
    expect(onopensessions).toHaveBeenCalledOnce();
  });

  it("reports a start failure inline and keeps Run Setup available", async () => {
    const api = fakeSetupRun({ start: vi.fn(async () => { throw new Error("Could not start the session."); }) });
    const agent = new SetupAgent(api);
    await mountIntro({ agent });
    await clickRunSetup();
    expect(q('[data-testid="setup-run-start-error"]')?.textContent).toBe("Could not start the session.");
    expect(q('[data-testid="setup-run"]')).not.toBeNull();
  });

  it("a remembered outcome shows the finished stepper and Open setup chat", async () => {
    saveSetupRunRecord({ sessionId: "sess-done", step: 5, status: "done" });
    const agent = new SetupAgent(fakeSetupRun());
    const onopensessiondetails = vi.fn();
    await mountIntro({ agent, onopensessiondetails });
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("done");
    const button = q('[data-testid="setup-run-details"]') as HTMLButtonElement;
    expect(button?.textContent?.trim()).toBe("Open setup chat");
    button.click();
    expect(onopensessiondetails).toHaveBeenCalledWith("sess-done");
  });
});
