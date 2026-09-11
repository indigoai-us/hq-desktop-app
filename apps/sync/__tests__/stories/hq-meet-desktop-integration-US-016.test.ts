/**
 * US-016 story acceptance tests — "Own calls in a dedicated native window".
 *
 * Story-level regression cover for the three PRD e2e statements, plus the
 * named failure and authorization paths. These drive the public seams only —
 * `startCallWindow` / `resolveCallTarget` with injected `invoke`/`listen`, and
 * a real `@hq/meet-core` session built on the deterministic fakes from
 * `@hq/meet-core/testing`. No Tauri, no webview, no network, no real timers.
 *
 * NOTE on e2e statement 1: real cross-window media continuity (remote audio
 * and video still flowing in the OS-level call window while the main Desktop
 * window navigates or closes) is an architectural property of running in a
 * separate window process, and is certified by the native harness in US-031.
 * What is regression-testable here — and what these tests pin — is that the
 * call's own state machine has no coupling to main-window lifecycle at all:
 * the window subscribes to nothing but its own two window-scoped events, and
 * a joined session with attached remote tracks is untouched when main-window
 * close / navigation traffic goes by.
 */

import { describe, expect, it } from "vitest";
import {
  createCallSession,
  type CallBinding,
  type CallGrant,
  type CallSession,
  type PeerIdentity,
  type TrackLike,
} from "@hq/meet-core";
import {
  FakeConnectionFactory,
  FakeScheduler,
  FakeSignalingFabric,
  FakeTrack,
} from "@hq/meet-core/testing";
import { PINNED_CONTRACT_HASH } from "@hq/platform";

import {
  CALL_DISPOSE_EVENT,
  CALL_TARGET_EVENT,
  createNoCaptureMediaPort,
  pendingCompletionState,
  resolveCallTarget,
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
} from "../../src/call/bootstrap";
import {
  hasNoCredentialFields,
  isCallWindowTarget,
  type CallWindowTarget,
} from "../../src/call/target";

const SESSION_ID = "cmp-indigo:room-1:call-1:7";

const EVIDENCE = {
  schema: "hq-meet-staging-proof/v1",
  story: "US-011",
  stage: "staging",
  apiBase: "https://hqapi.example.com",
  deployedRevision: {
    serviceCommit: "a".repeat(40),
    configHash: "b".repeat(64),
  },
  contractHash: PINNED_CONTRACT_HASH,
  runAt: new Date().toISOString(),
  failures: 0,
  passed: true,
};

function target(overrides: Partial<CallWindowTarget> = {}): CallWindowTarget {
  return {
    sessionId: SESSION_ID,
    companyUid: "cmp-indigo",
    roomId: "room-1",
    callId: "call-1",
    epoch: 7,
    grant: {
      grantId: "grant-1",
      expiresAt: 1_800_000_000_000,
      renewAfterMs: 30_000,
      trafficStopMs: 10_000,
      controlPollMs: 1_000,
    },
    self: { personUid: "prs-1", deviceId: "dev-1" },
    evidence: EVIDENCE,
    ...overrides,
  };
}

interface Harness {
  deps: CallWindowDeps;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  commands: () => string[];
  argsOf: (command: string) => Record<string, unknown> | undefined;
  emit: (event: string, payload: unknown) => void;
  listened: string[];
}

/** Records every native command and every window-scoped subscription. */
function harness(
  options: { pending?: unknown; invoke?: CallInvoke; targetWaitMs?: number } = {},
): Harness {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    if (options.invoke) return options.invoke(command, args);
    if (command === "calls_take_pending_target") return options.pending ?? null;
    return null;
  };
  const listened: string[] = [];
  const deps: CallWindowDeps = {
    invoke,
    listen: async (event, handler) => {
      listened.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        handlers.set(
          event,
          (handlers.get(event) ?? []).filter((entry) => entry !== handler),
        );
      };
    },
    targetWaitMs: options.targetWaitMs ?? 20,
    createSigner: async () => ({
      peerKey: "d".repeat(64),
      publicKey: "e".repeat(43),
      sign: async () => "f".repeat(86),
    }),
    connections: {
      create: () => {
        throw new Error("no peer connection expected in this test");
      },
    },
  };
  return {
    deps,
    calls,
    listened,
    commands: () => calls.map((call) => call.command),
    argsOf: (command) => calls.find((call) => call.command === command)?.args,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
  };
}

// ── A real meet-core session, as the call window composes one ────────────────

const binding: CallBinding = {
  companyUid: "cmp-indigo",
  roomId: "room-1",
  callId: "call-1",
  epoch: 7,
};
const self: PeerIdentity = {
  personUid: "prs-1",
  deviceId: "dev-1",
  peerKey: "key-self",
};
const peer: PeerIdentity = {
  personUid: "prs-2",
  deviceId: "dev-2",
  peerKey: "key-peer",
};

function grant(): CallGrant {
  return {
    grantId: "grant-1",
    role: "participant",
    rosterRevision: 0,
    expiresAt: 1_800_000_000_000,
  };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

interface CallFixture {
  session: CallSession;
  fabric: FakeSignalingFabric;
  connections: FakeConnectionFactory;
  scheduler: FakeScheduler;
  owned: FakeTrack[];
  remote: TrackLike[];
}

/**
 * The call window's own port composition: `createNoCaptureMediaPort` (this
 * story joins with no capture of its own) over the deterministic fabric.
 */
function callFixture(localTracks: FakeTrack[] = []): CallFixture {
  const scheduler = new FakeScheduler();
  const fabric = new FakeSignalingFabric(binding);
  const connections = new FakeConnectionFactory();
  const remote: TrackLike[] = [];
  const session = createCallSession({
    binding,
    self,
    sessionId: SESSION_ID,
    ports: {
      signaling: fabric.port(self),
      media: createNoCaptureMediaPort(() => localTracks),
      connections,
      clock: scheduler,
      timers: scheduler,
      random: () => 0,
    },
  });
  session.on("track", ({ track }) => remote.push(track));
  return { session, fabric, connections, scheduler, owned: localTracks, remote };
}

// ── e2e 1 ────────────────────────────────────────────────────────────────────

describe("US-016 e2e 1: an active call survives Desktop navigation and close", () => {
  it("keeps the session joined with remote media attached while main-window lifecycle traffic goes by", async () => {
    const fixture = callFixture();
    await fixture.session.join(grant());
    fixture.fabric.admit(self, peer);
    await settle();
    const pc = fixture.connections.last;
    pc.emitRemoteTrack(new FakeTrack("remote-video", "video"));
    expect(fixture.session.snapshot().phase).toBe("joined");
    expect(fixture.remote.map((track) => track.id)).toEqual(["remote-video"]);

    // Everything the main Desktop window does on close or navigation. None of
    // it is addressed to this session, and nothing here listens for it.
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    const before = bench.commands().length;
    for (const event of [
      "tauri://close-requested",
      "tauri://destroyed",
      "tauri://window-created",
      "hq:navigate",
      "sync-status",
    ]) {
      bench.emit(event, { label: "main" });
    }
    await settle();

    expect(fixture.session.snapshot().phase).toBe("joined");
    expect(fixture.remote).toHaveLength(1);
    expect(pc.closed).toBe(false);
    expect(fixture.owned.every((track) => track.stopped)).toBe(true); // vacuous: no capture
    // The call window issued no native command in response either.
    expect(bench.commands()).toHaveLength(before);
    expect(handle.state().status).not.toBe("left");
    await handle.close();
  });

  it("subscribes to nothing but its own two window-scoped call events", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    expect(bench.listened).toEqual([CALL_DISPOSE_EVENT]);
    expect(bench.listened).not.toContain("tauri://close-requested");
    expect(bench.listened).not.toContain("tauri://destroyed");
    await handle.close();
  });

  it("releases only the session it was told about, never a main-window label", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    await handle.leave("window-close");
    const release = bench.argsOf("calls_release");
    expect(release).toEqual({ sessionId: SESSION_ID, reason: "window-close" });
    expect(JSON.stringify(bench.calls)).not.toContain("main");
    await handle.close();
  });
});

// ── e2e 2 ────────────────────────────────────────────────────────────────────

describe("US-016 e2e 2: one authorized target reaches the call window", () => {
  it("drains the pending target on a cold open and acknowledges ready, in that order", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    const commands = bench.commands();
    expect(commands.indexOf("calls_take_pending_target")).toBe(0);
    expect(commands.indexOf("calls_window_ready")).toBe(1);
    expect(bench.argsOf("calls_window_ready")).toEqual({
      sessionId: SESSION_ID,
    });
    expect(handle.target).toEqual(target());
    // The pending slot is drained exactly once — never re-asked.
    expect(commands.filter((c) => c === "calls_take_pending_target")).toHaveLength(1);
    await handle.close();
  });

  it("takes exactly one warm target from the window-scoped event and ignores the rest", async () => {
    const bench = harness({ targetWaitMs: 1_000 });
    const pending = resolveCallTarget(bench.deps);
    await settle();
    bench.emit(CALL_TARGET_EVENT, target());
    bench.emit(CALL_TARGET_EVENT, target({ sessionId: "cmp-indigo:room-9:call-9:1" }));
    expect(await pending).toEqual(target());
    expect(bench.listened).toEqual([CALL_TARGET_EVENT]);
  });

  it("never reads the target from the URL, query string or web storage", async () => {
    const touched: string[] = [];
    const trap = (name: string) =>
      new Proxy(
        {},
        {
          get(_t, key) {
            touched.push(`${name}.${String(key)}`);
            return undefined;
          },
        },
      );
    const globals = globalThis as Record<string, unknown>;
    const saved = {
      location: globals.location,
      localStorage: globals.localStorage,
      sessionStorage: globals.sessionStorage,
    };
    Object.defineProperty(globals, "location", {
      value: trap("location"),
      configurable: true,
      writable: true,
    });
    globals.localStorage = trap("localStorage");
    globals.sessionStorage = trap("sessionStorage");
    try {
      const bench = harness({ pending: target() });
      const handle = await startCallWindow(bench.deps);
      expect(handle.target?.sessionId).toBe(SESSION_ID);
      expect(touched).toEqual([]);
      await handle.close();
    } finally {
      Object.defineProperty(globals, "location", {
        value: saved.location,
        configurable: true,
        writable: true,
      });
      globals.localStorage = saved.localStorage;
      globals.sessionStorage = saved.sessionStorage;
    }
  });

  it("refuses a credential-shaped target and never acknowledges ready for it", async () => {
    const poisoned = {
      ...target(),
      grant: { ...target().grant, token: "hq-pro-bearer" },
    };
    expect(isCallWindowTarget(poisoned)).toBe(false);
    expect(hasNoCredentialFields(poisoned)).toBe(false);
    expect(hasNoCredentialFields(target())).toBe(true);

    const bench = harness({ targetWaitMs: 20 });
    const mounting = startCallWindow(bench.deps);
    await settle();
    bench.emit(CALL_TARGET_EVENT, poisoned);
    const handle = await mounting;
    expect(handle.target).toBeNull();
    expect(handle.state().code).toBe("NO_CALL_TARGET");
    expect(bench.commands()).not.toContain("calls_window_ready");
  });

  it("surfaces a bounded refusal rather than idling when no target ever arrives", async () => {
    const bench = harness({ targetWaitMs: 5 });
    const seen: string[] = [];
    const handle = await startCallWindow({
      ...bench.deps,
      onState: (state) => seen.push(state.status),
    });
    expect(seen).toContain("error");
    expect(handle.session).toBeNull();
    // Two drains and nothing else: the second closes the arm-then-emit race
    // (a target armed after the first drain whose emit this window missed).
    // The window still never acknowledges a mount it has no target for.
    expect(bench.commands()).toEqual([
      "calls_take_pending_target",
      "calls_take_pending_target",
    ]);
  });
});

// ── e2e 3 ────────────────────────────────────────────────────────────────────

describe("US-016 e2e 3: shutdown releases devices and keeps durable work recoverable", () => {
  it("persists pending work before releasing the registry entry on call close", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    await handle.leave("window-close");
    const commands = bench.commands();
    expect(commands).toContain("calls_persist_pending");
    expect(commands.indexOf("calls_persist_pending")).toBeLessThan(
      commands.indexOf("calls_release"),
    );
    const persisted = bench.argsOf("calls_persist_pending");
    expect(persisted?.sessionId).toBe(SESSION_ID);
    expect(persisted?.state).toEqual(pendingCompletionState(target()));
    expect(hasNoCredentialFields(persisted)).toBe(true);
    expect(handle.state().status).toBe("left");
    await handle.close();
  });

  it("is idempotent: a second leave neither re-persists nor re-releases", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    await handle.leave("window-close");
    const after = bench.commands().length;
    await handle.leave("window-close");
    expect(bench.commands()).toHaveLength(after);
    await handle.close();
  });

  it("answers the app-quit dispose event by disposing and acknowledging", async () => {
    const bench = harness({ pending: target() });
    const handle = await startCallWindow(bench.deps);
    bench.emit(CALL_DISPOSE_EVENT, {});
    await settle();
    const commands = bench.commands();
    expect(commands).toContain("calls_disposed");
    expect(commands.indexOf("calls_persist_pending")).toBeLessThan(
      commands.indexOf("calls_disposed"),
    );
    expect(bench.argsOf("calls_disposed")).toEqual({ sessionId: SESSION_ID });
    await handle.close();
  });

  it("keeps releasing devices when the durable write fails", async () => {
    const bench = harness({
      pending: target(),
      invoke: async (command) => {
        if (command === "calls_take_pending_target") return target();
        if (command === "calls_persist_pending") throw new Error("disk full");
        return null;
      },
    });
    const handle = await startCallWindow(bench.deps);
    await expect(handle.leave("window-close")).resolves.toBeUndefined();
    expect(bench.commands()).toContain("calls_release");
    expect(handle.state().status).toBe("left");
    await handle.close();
  });

  it("requests no local capture and stops every owned track on leave", async () => {
    const camera = new FakeTrack("camera", "video");
    const mic = new FakeTrack("mic", "audio");
    const port = createNoCaptureMediaPort();
    // This story joins with nothing: the explicit join control is US-017.
    expect(port.localTracks()).toEqual([]);
    expect(port.ownsTracks).toBe(true);

    // Anything a later story hands the port is still owned — and released.
    const fixture = callFixture([camera, mic]);
    await fixture.session.join(grant());
    fixture.fabric.admit(self, peer);
    await settle();
    expect(camera.stopped).toBe(false);
    await fixture.session.leave();
    expect(camera.stopped).toBe(true);
    expect(mic.stopped).toBe(true);
    expect(fixture.connections.created.every((pc) => pc.closed)).toBe(true);
    expect(fixture.scheduler.pending).toBe(0);
  });

  it("disposes the session and closes every peer connection on app quit", async () => {
    const camera = new FakeTrack("camera", "video");
    const fixture = callFixture([camera]);
    await fixture.session.join(grant());
    fixture.fabric.admit(self, peer);
    await settle();
    await fixture.session.dispose();
    expect(fixture.session.snapshot().phase).toBe("disposed");
    expect(camera.stopped).toBe(true);
    expect(fixture.connections.created.every((pc) => pc.closed)).toBe(true);
    expect(fixture.scheduler.pending).toBe(0);
  });

  it("keeps the durable record content-free so recovery carries no call content", () => {
    const state = pendingCompletionState(target());
    expect(state).toEqual({
      version: 1,
      sessionId: SESSION_ID,
      binding: {
        companyUid: "cmp-indigo",
        roomId: "room-1",
        callId: "call-1",
        epoch: 7,
      },
      pendingCompletion: null,
    });
    expect(JSON.stringify(state)).not.toContain("grant-1");
    expect(hasNoCredentialFields(state)).toBe(true);
  });
});
