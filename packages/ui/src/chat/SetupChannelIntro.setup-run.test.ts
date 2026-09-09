// @vitest-environment happy-dom

// #welcome's Run Setup with a host guided-run API: the hero becomes the live
// card, questions are answered through the API (structured for
// questionRequest, plain send for a trailing question), the finish graduates
// boot, the run is resumable after a relaunch, and a not-ready preflight
// falls back to the Sessions page exactly as before.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
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

describe("SetupChannelIntro native setup run", () => {
  it("turns the hero into the live card, with no navigation and no graduation yet", async () => {
    const api = fakeSetupRun();
    const onopensessions = vi.fn();
    const onsetupstarted = vi.fn();
    await mountIntro({ setupRun: api, onopensessions, onsetupstarted });
    expect(q('[data-testid="setup-run-card"]')).toBeNull();

    await clickRunSetup();

    expect(api.preflight).toHaveBeenCalledOnce();
    expect(api.start).toHaveBeenCalledWith("/setup --guided");
    expect(onopensessions).not.toHaveBeenCalled();
    expect(onsetupstarted).not.toHaveBeenCalled();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("live");
    expect(q('[data-testid="setup-run"]')).toBeNull();
    expect(q('[data-testid="setup-run-step-tools"]')?.dataset.stepStatus).toBe("running");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 0, status: "running" });
  });

  it("the live run sits in a solid panel below the hero, not on the art", async () => {
    const api = fakeSetupRun();
    await mountIntro({ setupRun: api });
    await clickRunSetup();
    const panel = q('[data-testid="setup-run-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.closest('[data-testid="setup-hero"]')).toBeNull();
    expect(q('[data-testid="setup-hero"] [data-testid="setup-run-card"]')).toBeNull();
    expect(panel?.querySelector('[data-testid="setup-run-card"]')).not.toBeNull();
  });

  it("ticks steps and shows the agent's plain sentence, never a command", async () => {
    const api = fakeSetupRun();
    await mountIntro({ setupRun: api });
    await clickRunSetup();
    api.emit("sess-1", say("Checking what's already in place on this Mac."), "working");
    api.emit("sess-1", { kind: "toolCall", id: "t1", name: "Bash" });
    api.emit("sess-1", say("Everything is reachable. Now the HQ Cloud connection.\n\n`hq auth status`"));
    await settle();
    expect(q('[data-testid="setup-run-step-tools"]')?.dataset.stepStatus).toBe("done");
    expect(q('[data-testid="setup-run-step-cloud"]')?.dataset.stepStatus).toBe("running");
    expect(q('[data-testid="setup-run-status"]')?.textContent?.trim()).toBe("Everything is reachable.");
    expect(host.textContent).not.toContain("hq auth status");
    expect(host.textContent).not.toContain("Bash");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 1, status: "running" });
  });

  it("answers a structured question through the API and a trailing question through send", async () => {
    const api = fakeSetupRun();
    await mountIntro({ setupRun: api });
    await clickRunSetup();

    api.emit(
      "sess-1",
      {
        kind: "questionRequest",
        requestId: "req-1",
        questions: [{ id: "q1", text: "Sign in to HQ Cloud now?", options: [{ label: "Yes" }, { label: "Later" }] }],
      },
      "needsYou",
    );
    await settle();
    expect(q('[data-testid="setup-run-question"]')?.dataset.questionKind).toBe("choice");
    const choices = host.querySelectorAll<HTMLButtonElement>('[data-testid="setup-run-choice"]');
    choices[0]!.click();
    await settle();
    expect(api.answerQuestion).toHaveBeenCalledWith("sess-1", "req-1", [{ questionId: "q1", values: ["Yes"] }]);
    expect(q('[data-testid="setup-run-question"]')).toBeNull();

    api.emit("sess-1", say("Now let's get to know you.\n\n**What's your name?**"));
    api.emit("sess-1", turnDone, "idle");
    await settle();
    const question = q('[data-testid="setup-run-question"]');
    expect(question?.dataset.questionKind).toBe("text");
    expect(question?.textContent).toContain("What's your name?");
    const input = q('[data-testid="setup-run-answer"]') as HTMLInputElement;
    input.value = "Jacob";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(api.send).toHaveBeenCalledWith("sess-1", "Jacob");
    expect(q('[data-testid="setup-run-question"]')).toBeNull();
    expect(q('[data-testid="setup-run-step-you"]')?.dataset.stepStatus).toBe("running");
  });

  it("answers a permission ask through the API", async () => {
    const api = fakeSetupRun();
    await mountIntro({ setupRun: api });
    await clickRunSetup();
    api.emit("sess-1", { kind: "permissionRequest", requestId: "perm-1", toolName: "Bash" }, "needsYou");
    await settle();
    (q('[data-testid="setup-run-allow-session"]') as HTMLButtonElement).click();
    await settle();
    expect(api.respondPermission).toHaveBeenCalledWith("sess-1", "perm-1", "allowSession");
    expect(q('[data-testid="setup-run-question"]')).toBeNull();
  });

  it("finishes: done state, outcome remembered, and the host graduation hook fires once", async () => {
    const api = fakeSetupRun();
    const onsetupfinished = vi.fn();
    const onsetupstarted = vi.fn();
    await mountIntro({ setupRun: api, onsetupfinished, onsetupstarted });
    await clickRunSetup();
    api.emit("sess-1", say("Signed in as jacob@example.com."));
    api.emit("sess-1", say("You're all set — here's your welcome page (private to you): https://x.example/w\n\nYour first move:\n\n  /plan"));
    api.emit("sess-1", turnDone, "idle");
    await settle();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("done");
    expect(q('[data-testid="setup-run-done-title"]')?.textContent).toBe("You’re set up");
    expect(onsetupfinished).toHaveBeenCalledOnce();
    expect(onsetupstarted).not.toHaveBeenCalled();
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 5, status: "done" });
    api.emit("sess-1", { kind: "exited", code: 0 }, "ended");
    await settle();
    expect(onsetupfinished).toHaveBeenCalledOnce();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("done");
  });

  it("Show details hands the session id to the host", async () => {
    const api = fakeSetupRun();
    const onopensessiondetails = vi.fn();
    await mountIntro({ setupRun: api, onopensessiondetails });
    await clickRunSetup();
    (q('[data-testid="setup-run-details"]') as HTMLButtonElement).click();
    expect(onopensessiondetails).toHaveBeenCalledWith("sess-1");
  });

  it("resumes a remembered run on its own: coming back re-attaches without a click", async () => {
    const api = fakeSetupRun();
    api.exists("sess-old");
    saveSetupRunRecord({ sessionId: "sess-old", step: 2, status: "running" });
    await mountIntro({ setupRun: api });
    expect(q('[data-testid="setup-run"]')).toBeNull();
    await settle();
    expect(api.attach).toHaveBeenCalledWith("sess-old");
    expect(api.start).not.toHaveBeenCalled();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("live");
    api.emit("sess-old", say("Welcome back. **What do you do?**"));
    api.emit("sess-old", turnDone, "idle");
    await settle();
    expect(q('[data-testid="setup-run-question"]')?.textContent).toContain("What do you do?");
  });

  it("offers Run Setup again when the remembered session is gone, and starts fresh", async () => {
    const api = fakeSetupRun();
    saveSetupRunRecord({ sessionId: "sess-gone", step: 1, status: "running" });
    await mountIntro({ setupRun: api });
    await settle();
    expect(api.attach).toHaveBeenCalledWith("sess-gone");
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("stopped");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-gone", step: 1, status: "ended" });
    (q('[data-testid="setup-run-again"]') as HTMLButtonElement).click();
    await settle();
    expect(api.start).toHaveBeenCalledOnce();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("live");
    expect(loadSetupRunRecord()?.sessionId).toBe("sess-1");
  });

  it("falls back to the Sessions page when preflight says this Mac is not ready", async () => {
    const api = fakeSetupRun({ preflight: vi.fn(async () => "needs-sessions-page" as const) });
    const onopensessions = vi.fn();
    const onsetupstarted = vi.fn();
    await mountIntro({ setupRun: api, onopensessions, onsetupstarted });
    await clickRunSetup();
    expect(api.start).not.toHaveBeenCalled();
    expect(onopensessions).toHaveBeenCalledOnce();
    expect(onsetupstarted).toHaveBeenCalledOnce();
    expect(q('[data-testid="setup-run-card"]')).toBeNull();
  });

  it("reports a start failure inline and keeps Run Setup available", async () => {
    const api = fakeSetupRun({ start: vi.fn(async () => { throw new Error("Could not start the session."); }) });
    await mountIntro({ setupRun: api });
    await clickRunSetup();
    expect(q('[data-testid="setup-run-card"]')).toBeNull();
    expect(q('[data-testid="setup-run-start-error"]')?.textContent).toBe("Could not start the session.");
    expect((q('[data-testid="setup-run"]') as HTMLButtonElement).disabled).toBe(false);
    expect(loadSetupRunRecord()).toBeNull();
  });
});

describe("SetupChannelIntro remembers the setup outcome", () => {
  it("coming back after a finished run shows Setup complete, not a fresh Run Setup", async () => {
    const api = fakeSetupRun();
    saveSetupRunRecord({ sessionId: "sess-done", step: 3, status: "done" });
    const onsetupfinished = vi.fn();
    await mountIntro({ setupRun: api, onsetupfinished });
    expect(q('[data-testid="setup-run"]')).toBeNull();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("done");
    expect(q('[data-testid="setup-run-done-title"]')?.textContent).toBe("You’re set up");
    expect(onsetupfinished).not.toHaveBeenCalled();
    expect(api.attach).not.toHaveBeenCalled();
    expect(loadSetupRunRecord()?.status).toBe("done");
  });

  it("Run again from a remembered outcome starts a fresh run", async () => {
    const api = fakeSetupRun();
    saveSetupRunRecord({ sessionId: "sess-done", step: 3, status: "done" });
    await mountIntro({ setupRun: api });
    (q('[data-testid="setup-run-again"]') as HTMLButtonElement).click();
    await settle();
    expect(api.start).toHaveBeenCalledOnce();
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("live");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 0, status: "running" });
  });

  it("a run that ended early keeps its paused card and its record", async () => {
    const api = fakeSetupRun();
    saveSetupRunRecord({ sessionId: "sess-ended", step: 1, status: "ended" });
    await mountIntro({ setupRun: api });
    expect(q('[data-testid="setup-run-card"]')?.dataset.setupRunMode).toBe("stopped");
    expect(q('[data-testid="setup-run-again"]')).not.toBeNull();
    expect(loadSetupRunRecord()?.status).toBe("ended");
  });

  it("a run that exits before finishing is remembered as ended", async () => {
    const api = fakeSetupRun();
    await mountIntro({ setupRun: api });
    await clickRunSetup();
    api.emit("sess-1", say("Checking what's already in place on this Mac."), "working");
    api.emit("sess-1", { kind: "exited", code: 1 }, "ended");
    await settle();
    expect(loadSetupRunRecord()).toMatchObject({ sessionId: "sess-1", status: "ended" });
  });
});

describe("SetupChannelIntro before the first click", () => {
  it("shows the six setup steps under Run Setup so the plan is visible up front", async () => {
    await mountIntro({ setupRun: fakeSetupRun() });
    const preview = q('[data-testid="setup-steps-preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.querySelectorAll("li").length).toBe(6);
    expect(preview?.textContent).toContain("HQ Cloud");
    expect(q('[data-testid="setup-run"]')).not.toBeNull();
  });

  it("a remembered outcome offers Open setup chat back to the session", async () => {
    const onopensessiondetails = vi.fn();
    saveSetupRunRecord({ sessionId: "sess-done", step: 3, status: "done" });
    await mountIntro({ setupRun: fakeSetupRun(), onopensessiondetails });
    const button = q('[data-testid="setup-run-details"]') as HTMLButtonElement;
    expect(button?.textContent?.trim()).toBe("Open setup chat");
    button.click();
    expect(onopensessiondetails).toHaveBeenCalledWith("sess-done");
  });
});
