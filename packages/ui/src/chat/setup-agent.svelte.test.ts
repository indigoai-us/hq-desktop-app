// @vitest-environment happy-dom
//
// The Setup Agent store: the guided run as a conversation. Start / resume /
// answer / finish, the resume record, and the transcript the channel shows.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SETUP_RETRY_DELAY_MS, SetupAgent, loadTranscriptCache, setupAgentProse, setupAgentTranscript } from "./setup-agent.svelte";
import {
  loadSetupRunRecord,
  SETUP_FAILURE_COPY,
  saveSetupRunRecord,
  type SetupRunApi,
  type SetupRunEvent,
  type SetupRunPhase,
  type SetupRunSnapshot,
} from "./setup-run";

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


const say = (text: string): SetupRunEvent => ({ kind: "assistantMessage", text });
const turnDone: SetupRunEvent = { kind: "turnDone", status: "success" };

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("setupAgentProse", () => {
  it("strips protocol markers and keeps the person-facing words", () => {
    expect(setupAgentProse("`[hq-setup] step=tools status=running`\n\nLet me look at the tools.")).toBe(
      "Let me look at the tools.",
    );
    expect(
      setupAgentProse('Found some history.\n\n[hq-setup] card={"kind":"found","items":[{"label":"Plans","count":3}]}'),
    ).toBe("Found some history.");
    expect(setupAgentProse("[hq-setup] step=cloud status=done")).toBe("");
  });
});

describe("setupAgentTranscript", () => {
  it("turns assistant and user events into turns, skipping the launch prompt and sub-agent chatter", () => {
    const turns = setupAgentTranscript("s1", [
      { kind: "userMessage", text: "/setup --guided" },
      say("[hq-setup] step=tools status=running\nChecking tools."),
      { kind: "toolCall", id: "t1", name: "Bash" },
      { kind: "assistantMessage", text: "inner", parentToolUseId: "t1" },
      say("All good. What's your name?"),
      { kind: "userMessage", text: "Jacob" },
    ]);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ["agent", "Checking tools."],
      ["agent", "All good. What's your name?"],
      ["user", "Jacob"],
    ]);
    expect(turns[0]!.id).toBe("setup:s1:1");
  });

  it("collapses a streaming message that grows in place", () => {
    const turns = setupAgentTranscript("s1", [say("Checking"), say("Checking tools now.")]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toBe("Checking tools now.");
  });
});

describe("SetupAgent", () => {
  it("is idle without a host api and never active", () => {
    const agent = new SetupAgent(null);
    expect(agent.active).toBe(false);
    expect(agent.listening).toBe(false);
  });

  it("starts the guided run, remembers it as running, and listens", async () => {
    const api = fakeSetupRun();
    const onstarted = vi.fn();
    const agent = new SetupAgent(api, { onstarted });
    expect(await agent.start()).toBe("started");
    expect(api.start).toHaveBeenCalledWith("/setup --guided");
    expect(agent.mode).toBe("live");
    expect(agent.sessionId).toBe("sess-1");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 0, status: "running" });
    expect(onstarted).toHaveBeenCalledOnce();
    api.emit("sess-1", say("Checking what's in place."), "working");
    expect(agent.listening).toBe(true);
    expect(agent.transcript.map((t) => t.text)).toEqual(["Checking what's in place."]);
  });

  it("hands off when the host preflight is not ready, without starting", async () => {
    const api = fakeSetupRun({ preflight: vi.fn(async () => "needs-sessions-page" as const) });
    const agent = new SetupAgent(api);
    expect(await agent.start()).toBe("needs-sessions-page");
    expect(api.start).not.toHaveBeenCalled();
    expect(agent.mode).toBe("idle");
  });

  it("reports a start failure and stays idle so Run Setup can be tried again", async () => {
    const api = fakeSetupRun({ start: vi.fn(async () => { throw new Error("Could not start the session."); }) });
    const agent = new SetupAgent(api);
    await agent.start();
    expect(agent.mode).toBe("idle");
    expect(agent.error).toBe("Could not start the session.");
  });

  it("a typed reply answers the open structured question, otherwise it is the next turn", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit(
      "sess-1",
      { kind: "questionRequest", requestId: "req-1", questions: [{ id: "q1", text: "Name?", options: [{ label: "Skip" }] }] },
      "needsYou",
    );
    expect(agent.state?.question?.kind).toBe("choice");
    await agent.reply("Jacob");
    expect(api.answerQuestion).toHaveBeenCalledWith("sess-1", "req-1", [{ questionId: "q1", values: ["Jacob"] }]);
    expect(api.send).not.toHaveBeenCalled();
    api.emit("sess-1", say("Thanks. What do you do?"), "idle");
    api.emit("sess-1", turnDone, "idle");
    await agent.reply("I run a shop");
    expect(api.send).toHaveBeenCalledWith("sess-1", "I run a shop");
    expect(agent.transcript.at(-1)).toMatchObject({ role: "user", text: "I run a shop" });
  });

  it("answers a permission ask through the api", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", { kind: "permissionRequest", requestId: "perm-1", toolName: "Bash" }, "needsYou");
    await agent.answerPermission("perm-1", "allowSession");
    expect(api.respondPermission).toHaveBeenCalledWith("sess-1", "perm-1", "allowSession");
  });

  it("finishes: done, the outcome remembered, listening stops, and the host hook fires once", async () => {
    const api = fakeSetupRun();
    const onfinished = vi.fn();
    const agent = new SetupAgent(api, { onfinished });
    await agent.start();
    api.emit("sess-1", say("You're all set — here's your welcome page: https://x.example/w"));
    api.emit("sess-1", turnDone, "idle");
    expect(agent.state?.done).toBe(true);
    expect(agent.listening).toBe(false);
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 5, status: "done" });
    api.emit("sess-1", { kind: "exited", code: 0 }, "ended");
    expect(onfinished).toHaveBeenCalledOnce();
  });

  it("picks a running run back up on its own, and marks a vanished one ended", async () => {
    const api = fakeSetupRun();
    api.exists("sess-old");
    saveSetupRunRecord({ sessionId: "sess-old", step: 2, status: "running" });
    const agent = new SetupAgent(api);
    await settle();
    expect(api.attach).toHaveBeenCalledWith("sess-old");
    expect(agent.mode).toBe("live");

    window.localStorage.clear();
    saveSetupRunRecord({ sessionId: "sess-gone", step: 1, status: "running" });
    const gone = new SetupAgent(fakeSetupRun());
    await settle();
    expect(gone.mode).toBe("stopped");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-gone", step: 1, status: "ended" });
  });

  it("a remembered outcome shows as done or paused, re-attaching quietly for its transcript", async () => {
    saveSetupRunRecord({ sessionId: "sess-done", step: 5, status: "done" });
    const api = fakeSetupRun();
    api.exists("sess-done");
    const done = new SetupAgent(api);
    await settle();
    expect(done.mode).toBe("done");
    expect(done.active).toBe(true);
    expect(api.attach).toHaveBeenCalledWith("sess-done");
    expect(api.start).not.toHaveBeenCalled();

    saveSetupRunRecord({ sessionId: "sess-ended", step: 1, status: "ended" });
    expect(new SetupAgent(api).mode).toBe("stopped");
  });

  it("the person's answers to chips and permission asks show as their own turns", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", say("Want me to import?"));
    api.emit(
      "sess-1",
      { kind: "questionRequest", requestId: "req-1", questions: [{ id: "q1", text: "Import?", options: [{ label: "Skip for now" }] }] },
      "needsYou",
    );
    await agent.answerChoice("req-1", "q1", ["Skip for now"]);
    api.emit("sess-1", { kind: "permissionRequest", requestId: "perm-1", toolName: "Bash" }, "needsYou");
    await agent.answerPermission("perm-1", "allowSession");
    api.emit("sess-1", say("Done."));
    expect(agent.transcript.map((t) => [t.role, t.text])).toEqual([
      ["agent", "Want me to import?"],
      ["user", "Skip for now"],
      ["user", "Allowed for the rest of setup"],
      ["agent", "Done."],
    ]);
  });

  it("keeps the conversation when the engine no longer has the session", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", say("Checking tools."));
    api.emit("sess-1", say("You're all set."));
    api.emit("sess-1", turnDone, "idle");
    expect(loadTranscriptCache("sess-1").map((t) => t.text)).toEqual(["Checking tools.", "You're all set."]);

    // A relaunch: same record, but a fresh engine that never heard of sess-1.
    const later = new SetupAgent(fakeSetupRun());
    await settle();
    expect(later.mode).toBe("done");
    expect(later.transcript.map((t) => t.text)).toEqual(["Checking tools.", "You're all set."]);
  });

  it("asks the host which agents are ready and reports readiness", async () => {
    const providers = vi.fn(async () => ({ hqReady: true, claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, codexLoggedIn: false }));
    const agent = new SetupAgent(fakeSetupRun({ providers }));
    await settle();
    expect(agent.providersReady).toBe(false);
    providers.mockResolvedValue({ hqReady: true, claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false });
    await agent.refreshProviders(true);
    expect(providers).toHaveBeenLastCalledWith(true);
    expect(agent.providersReady).toBe(true);
    // A host that cannot say leaves the decision to preflight.
    expect(new SetupAgent(fakeSetupRun()).providersReady).toBe(true);
  });

  it("an expired sign-in stops the run with a plain line, not the engine's error, and asks which agents are ready", async () => {
    const providers = vi.fn(async () => ({ hqReady: true, claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, codexLoggedIn: false }));
    const api = fakeSetupRun({ providers });
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", say("Checking tools."));
    api.emit("sess-1", say("Failed to authenticate: OAuth session expired and could not be refreshed"));
    api.emit("sess-1", { kind: "turnDone", status: "error", error: null }, "ended");
    await settle();
    expect(agent.state?.ended).toBe(true);
    expect(agent.listening).toBe(false);
    expect(agent.failure?.kind).toBe("auth");
    const texts = agent.transcript.map((turn) => turn.text);
    expect(texts).not.toContain("Failed to authenticate: OAuth session expired and could not be refreshed");
    expect(texts[texts.length - 1]).toContain("sign-in for your coding agent has expired");
    expect(providers).toHaveBeenCalledWith(true);
    expect(agent.providersReady).toBe(false);
  });

  const REFRESH_CLASH = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh";

  it("a sign-in refresh clash ends the stuck process and retries once on its own, thinking meanwhile", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async (_sessionId: string) => {});
      const api = fakeSetupRun({ stop });
      const agent = new SetupAgent(api);
      await agent.start("claude");
      api.emit("sess-1", say("Checking tools."));
      api.emit("sess-1", { kind: "error", message: REFRESH_CLASH }, "ended");
      await settle();
      // Not a stop from the person's point of view: the channel keeps thinking.
      expect(stop).toHaveBeenCalledWith("sess-1");
      expect(agent.retrying).toBe(true);
      expect(agent.failure).toBeNull();
      expect(agent.active).toBe(true);
      expect(api.start).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(SETUP_RETRY_DELAY_MS);
      await settle();
      expect(api.start).toHaveBeenCalledTimes(2);
      expect(api.start).toHaveBeenLastCalledWith(expect.any(String), "claude");
      expect(agent.sessionId).toBe("sess-2");
      expect(agent.retrying).toBe(false);
      expect(agent.mode).toBe("live");
      expect(agent.attempts).toBe(2);
      expect(loadSetupRunRecord()).toMatchObject({ sessionId: "sess-2", status: "running" });

      // The same clash twice is a real stop: say so, with a word that we tried.
      api.emit("sess-2", { kind: "error", message: REFRESH_CLASH }, "ended");
      await vi.advanceTimersByTimeAsync(SETUP_RETRY_DELAY_MS * 2);
      await settle();
      expect(api.start).toHaveBeenCalledTimes(2);
      expect(stop).toHaveBeenCalledWith("sess-2");
      expect(agent.failure).toMatchObject({ kind: "other", transient: true });
      expect(agent.failureDetail).toContain("hiccup refreshing its sign-in");
      expect(agent.failureDetail).toContain("Tried again just now");
      expect(agent.transcript.map((turn) => turn.text)).not.toContain(REFRESH_CLASH);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh click resets the retry budget, and run again ends the previous session first", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async (_sessionId: string) => {});
      const api = fakeSetupRun({ stop });
      const agent = new SetupAgent(api);
      await agent.start();
      api.emit("sess-1", { kind: "error", message: REFRESH_CLASH }, "ended");
      await settle();
      expect(agent.retrying).toBe(true);
      // The person clicks Run Setup during the countdown: their pick wins, once.
      await agent.runAgain("codex");
      expect(agent.retrying).toBe(false);
      expect(api.start).toHaveBeenCalledTimes(2);
      expect(api.start).toHaveBeenLastCalledWith(expect.any(String), "codex");
      expect(agent.attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(SETUP_RETRY_DELAY_MS * 2);
      expect(api.start).toHaveBeenCalledTimes(2);
      // A clash on the new run gets its own single retry.
      api.emit("sess-2", { kind: "error", message: REFRESH_CLASH }, "ended");
      await settle();
      expect(agent.retrying).toBe(true);
      await vi.advanceTimersByTimeAsync(SETUP_RETRY_DELAY_MS);
      await settle();
      expect(api.start).toHaveBeenCalledTimes(3);
      expect(stop.mock.calls.map(([id]) => id)).toEqual(["sess-1", "sess-2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a real stop ends the stuck process too, and run again goes straight to starting, never through idle", async () => {
    const stop = vi.fn(async (_sessionId: string) => {});
    const api = fakeSetupRun({ stop });
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", say("Failed to authenticate: OAuth session expired and could not be refreshed"));
    api.emit("sess-1", { kind: "turnDone", status: "error", error: null }, "ended");
    await settle();
    expect(stop).toHaveBeenCalledWith("sess-1");
    expect(agent.failure?.kind).toBe("auth");
    expect(agent.failureDetail).not.toContain("Tried again");
    const modes: string[] = [];
    const pending = agent.runAgain("claude");
    modes.push(agent.mode);
    await pending;
    expect(modes).toEqual(["starting"]);
    expect(agent.mode).toBe("live");
    expect(agent.sessionId).toBe("sess-2");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("a remembered run whose last words were the finish is done, even if an older build recorded it as ended", async () => {
    saveSetupRunRecord({ sessionId: "sess-old", step: 5, status: "ended" });
    window.localStorage.setItem(
      "hq.welcome.setup-run-transcript.v1",
      JSON.stringify({
        sessionId: "sess-old",
        turns: [{ id: "setup:sess-old:9", role: "agent", text: "All set — you're done. Here's where you landed.\n\n- You're signed in to HQ Cloud as x@y.com.", seq: 9 }],
      }),
    );
    const agent = new SetupAgent(fakeSetupRun());
    await settle();
    expect(agent.mode).toBe("done");
    expect(agent.failure).toBeNull();
    expect(agent.transcript.map((turn) => turn.text)[0]).toContain("All set — you're done");
    expect(loadSetupRunRecord()?.status).toBe("done");
  });

  it("a remembered sign-in stop whose session is gone still reads plainly and asks which agents are ready", async () => {
    saveSetupRunRecord({ sessionId: "sess-gone", step: 0, status: "ended", failure: { kind: "auth", message: "Failed to authenticate: OAuth session expired and could not be refreshed" } });
    window.localStorage.setItem(
      "hq.welcome.setup-run-transcript.v1",
      JSON.stringify({
        sessionId: "sess-gone",
        turns: [{ id: "setup:sess-gone:6", role: "agent", text: "Failed to authenticate: OAuth session expired and could not be refreshed", seq: 6 }],
      }),
    );
    const providers = vi.fn(async () => ({ hqReady: true, claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, codexLoggedIn: false }));
    const agent = new SetupAgent(fakeSetupRun({ providers }));
    await settle();
    expect(agent.mode).toBe("stopped");
    expect(agent.failure?.kind).toBe("auth");
    expect(agent.transcript.map((turn) => turn.text)).toEqual([SETUP_FAILURE_COPY.auth.agent]);
    expect(providers).toHaveBeenCalledWith(true);
    expect(agent.providersReady).toBe(false);
  });

  it("any other stop keeps the words but adds the plain 'run again' line once", async () => {
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    await agent.start();
    api.emit("sess-1", say("Checking tools."));
    api.emit("sess-1", { kind: "error", message: "Process crashed" }, "ended");
    await settle();
    expect(agent.failure).toEqual({ kind: "other", message: "Process crashed" });
    const texts = agent.transcript.map((turn) => turn.text);
    expect(texts).toEqual(["Checking tools.", "I hit a snag and had to stop. Run Setup to try again."]);
  });

  it("run again starts a fresh session", async () => {
    saveSetupRunRecord({ sessionId: "sess-done", step: 5, status: "done" });
    const api = fakeSetupRun();
    const agent = new SetupAgent(api);
    expect(await agent.runAgain()).toBe("started");
    expect(agent.sessionId).toBe("sess-1");
    expect(loadSetupRunRecord()).toEqual({ sessionId: "sess-1", step: 0, status: "running" });
  });

  it("stores a secret through the host, never as a turn", async () => {
    const storeSecret = vi.fn(async () => {});
    const api = fakeSetupRun({ storeSecret });
    const agent = new SetupAgent(api);
    await agent.start();
    await agent.storeSecret({ kind: "secret", name: "DATABASE_URL", scope: "personal" }, "postgres://x");
    expect(storeSecret).toHaveBeenCalledWith(expect.objectContaining({ name: "DATABASE_URL" }), "postgres://x");
    expect(api.send).not.toHaveBeenCalled();
    expect(agent.canStoreSecrets).toBe(true);
    expect(new SetupAgent(fakeSetupRun()).canStoreSecrets).toBe(false);
  });
});
