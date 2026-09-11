/**
 * US-017 story acceptance tests — "Bind call identity and media permissions to
 * the active account".
 *
 * Story-level regression cover for the five PRD e2e statements plus the named
 * failure and authorization paths. Everything drives public seams only:
 * `startCallWindow` with injected `invoke`/`listen`/`whoami`/`getUserMedia`,
 * and — where the statement is about the engine's own authoritative events —
 * a real `@hq/meet-core` session over the deterministic fakes, wired to the
 * content gate exactly as `startCallWindow` wires it. No Tauri, no webview,
 * no WebRTC, no network, no real timers, and no capture anywhere.
 *
 * `src/call/*.test.ts` pin the units and the bootstrap wiring; this file pins
 * the story-level behaviour those units are supposed to add up to.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createCallSession,
  createConsentGate,
  createContentDeliveryGate,
  type CallBinding,
  type CallGrant,
  type CallSnapshot,
  type ContentGateEvent,
  type PeerIdentity,
} from "@hq/meet-core";
import {
  FakeConnectionFactory,
  FakeScheduler,
  FakeSignalingFabric,
  FakeTrack,
} from "@hq/meet-core/testing";

import { AUTH_SESSION_EVENT } from "../../src/call/auth";
import {
  createNoCaptureMediaPort,
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
} from "../../src/call/bootstrap";
import { MEDIA_PREFS_KEY } from "../../src/call/permissions";
import type { CallWindowTarget } from "../../src/call/target";

const SESSION_ID = "cmp-indigo:room-1:call-1:7";
/** A Cognito subject: the adapter's display-only degrade path. Never a grant. */
const COGNITO_SUBJECT = "6f0a1e2c-1111-4222-8333-444455556666";

/**
 * US-018: the admit the call window signs for itself. The benches below answer
 * it so the window can reach a session; every other hq-pro route still refuses.
 */
const ADMIT_PATH = "/v1/meet-native/signaling/admit";
const ADMIT_RESPONSE = {
  code: "OK",
  grant: {
    grantId: "grant-1",
    role: "participant",
    rosterRevision: 0,
    expiresAt: 1_800_000_000_000,
  },
  renewAfterMs: 30_000,
  trafficStopMs: 10_000,
  controlPollMs: 1_000,
};

function target(overrides: Partial<CallWindowTarget> = {}): CallWindowTarget {
  return {
    sessionId: SESSION_ID,
    companyUid: "cmp-indigo",
    roomId: "room-1",
    callId: "call-1",
    epoch: 7,
    self: { personUid: "prs_1", deviceId: "dev-1" },
    ...overrides,
  };
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function denial(name = "NotAllowedError"): Error {
  return Object.assign(new Error("refused"), { name });
}

// ── The window bench: every native and platform seam injected ────────────────

interface Bench {
  deps: CallWindowDeps;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  commands: () => string[];
  argsOf: (command: string) => Record<string, unknown> | undefined;
  emit: (event: string, payload: unknown) => void;
  listened: string[];
  getUserMedia: ReturnType<typeof vi.fn>;
  stops: number;
}

function bench(
  options: {
    generation?: number;
    /** `null` makes `whoami` fail outright; a string is what it resolves to. */
    personUid?: string | null;
    getUserMedia?: CallWindowDeps["getUserMedia"];
    storage?: CallWindowDeps["storage"];
    invoke?: CallInvoke;
  } = {},
): Bench {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const listened: string[] = [];
  const state = { stops: 0 };

  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    const custom = await options.invoke?.(command, args);
    if (custom !== undefined) return custom;
    if (command === "calls_take_pending_target") return target();
    if (command === "get_auth_session") {
      return {
        accountId: "acct-1",
        generation: options.generation ?? 1,
        status: "active",
        reason: null,
      };
    }
    if (command === "hq_pro_fetch") {
      const url = String(((args ?? {}) as { url?: unknown }).url ?? "");
      // The window admits itself before it can build a session (US-018).
      if (url === ADMIT_PATH) {
        return { status: 200, body: JSON.stringify(ADMIT_RESPONSE) };
      }
      // Every other hq-pro round trip refuses politely: this story needs no
      // live signaling exchange, and a refusal keeps it free of network shape.
      return { status: 503, body: "{}" };
    }
    return null;
  };

  const getUserMedia =
    (options.getUserMedia as ReturnType<typeof vi.fn>) ??
    vi.fn(async () => ({
      getTracks: () => [
        {
          id: "audio-1",
          kind: "audio",
          stop: () => {
            state.stops += 1;
          },
        },
      ],
    }));

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
    targetWaitMs: 20,
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
    identity: {
      whoami: (async () =>
        options.personUid === null
          ? { ok: false as const, reason: "error" as const }
          : {
              ok: true as const,
              value: {
                personUid: options.personUid ?? "prs_1",
                email: "a@b.c",
              },
            }) as never,
    },
    getUserMedia: getUserMedia as never,
    storage: options.storage ?? null,
  };

  return {
    deps,
    calls,
    listened,
    commands: () => calls.map((entry) => entry.command),
    argsOf: (command) => calls.find((entry) => entry.command === command)?.args,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
    getUserMedia,
    get stops(): number {
      return state.stops;
    },
  };
}

// ── A real meet-core session wired to the content gate as the window does ────

const binding: CallBinding = {
  companyUid: "cmp-indigo",
  roomId: "room-1",
  callId: "call-1",
  epoch: 7,
};
const self: PeerIdentity = {
  personUid: "prs_1",
  deviceId: "dev-1",
  peerKey: "key-self",
};
const peerA: PeerIdentity = {
  personUid: "prs_2",
  deviceId: "dev-2",
  peerKey: "key-a",
};
const peerB: PeerIdentity = {
  personUid: "prs_3",
  deviceId: "dev-3",
  peerKey: "key-b",
};
const labelOf = (peer: PeerIdentity): string =>
  `${peer.personUid} ${peer.deviceId}`;

function grant(overrides: Partial<CallGrant> = {}): CallGrant {
  return {
    grantId: "grant-1",
    role: "participant",
    rosterRevision: 0,
    expiresAt: 1_800_000_000_000,
    trafficStopMs: 10_000,
    ...overrides,
  };
}

/**
 * The composition `startCallWindow` builds: a session over the deterministic
 * fabric, with the content-delivery gate driven from the SAME authoritative
 * snapshot (peer removal closes that peer, traffic stop closes the call) and
 * remote tracks filtered through the gate before delivery.
 */
function wiredCall(grantOverrides: Partial<CallGrant> = {}) {
  const scheduler = new FakeScheduler();
  const fabric = new FakeSignalingFabric(binding);
  const connections = new FakeConnectionFactory();
  const content = createContentDeliveryGate();
  const closes: ContentGateEvent[] = [];
  const delivered: string[] = [];
  content.onClose((event) => closes.push(event));

  const session = createCallSession({
    binding,
    self,
    sessionId: SESSION_ID,
    ports: {
      signaling: fabric.port(self),
      media: createNoCaptureMediaPort(),
      connections,
      clock: scheduler,
      timers: scheduler,
      random: () => 0,
    },
  });

  let currentPeers: string[] = [];
  session.on("state", ({ snapshot }: { snapshot: CallSnapshot }) => {
    const peerIds = snapshot.peers.map((peer) => peer.peerId);
    const present = new Set(peerIds);
    for (const peerId of currentPeers) {
      if (!present.has(peerId)) content.closePeer(peerId, "peer-removed");
    }
    currentPeers = peerIds;
    content.admit(peerIds);
    if (snapshot.trafficStopped) content.closeAll("traffic-stopped");
  });
  session.on("track", ({ peer, track }) => {
    const peerId = labelOf(peer);
    if (!content.allows(peerId)) return;
    delivered.push(`${peerId}:${track.id}`);
  });

  return {
    scheduler,
    fabric,
    connections,
    content,
    closes,
    delivered,
    session,
    grant: grant(grantOverrides),
  };
}

// ── e2e 1 ────────────────────────────────────────────────────────────────────

describe("US-017 e2e 1: joining pauses until the canonical identity resolves", () => {
  it("pauses with a recoverable identity error when only a Cognito subject is available", async () => {
    const harness = bench({ personUid: COGNITO_SUBJECT });
    const handle = await startCallWindow(harness.deps);

    expect(handle.state().status).toBe("identity");
    expect(handle.state().code).toBe("IDENTITY_UNRESOLVED");
    expect(handle.state().recoverable).toBe(true);
    // No join, no capture, and the registry entry is still held so the Retry
    // has a call to come back to.
    expect(handle.session).toBeNull();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(harness.commands()).not.toContain("calls_release");
    await handle.close();
  });

  it("pauses the same way when the identity call fails outright", async () => {
    const harness = bench({ personUid: null });
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().status).toBe("identity");
    expect(handle.state().code).toBe("IDENTITY_UNRESOLVED");
    expect(handle.state().recoverable).toBe(true);
    expect(handle.session).toBeNull();
    await handle.close();
  });

  it("authorization path: the Retry joins once the canonical prs_ identity arrives", async () => {
    let personUid = COGNITO_SUBJECT;
    const harness = bench();
    harness.deps.identity = {
      whoami: (async () => ({ ok: true as const, value: { personUid } })) as never,
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.session).toBeNull();

    personUid = "prs_1";
    await handle.retryIdentity();
    expect(handle.session).not.toBeNull();
    expect(handle.state().status).not.toBe("identity");
    expect(handle.state().code).not.toBe("IDENTITY_UNRESOLVED");
    await handle.close();
  });

  it("failure path: a different canonical account is refused for good and releases", async () => {
    const harness = bench({ personUid: "prs_9" });
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().status).toBe("error");
    expect(handle.state().code).toBe("IDENTITY_MISMATCH");
    expect(handle.state().recoverable).toBe(false);
    expect(handle.session).toBeNull();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "identity_mismatch",
    });
    await handle.close();
  });
});

// ── e2e 2 ────────────────────────────────────────────────────────────────────

describe("US-017 e2e 2: an account switch discards a grant still in the air", () => {
  it("discards the delayed grant so the old session can never capture", async () => {
    const harness = bench();
    let switchAccount: (() => void) | undefined;
    harness.deps.createSigner = (async () => {
      // The switch lands while the device key is minted — i.e. while the join
      // is in flight and the grant it will use is still in the air.
      switchAccount?.();
      return {
        peerKey: "d".repeat(64),
        publicKey: "e".repeat(43),
        sign: async () => "f".repeat(86),
      };
    }) as never;
    const started = startCallWindow(harness.deps);
    switchAccount = () =>
      harness.emit(AUTH_SESSION_EVENT, {
        accountId: "acct-2",
        generation: 9,
        status: "active",
        reason: null,
      });
    const handle = await started;
    await settle();

    expect(handle.account?.invalidated).toBe(true);
    expect(handle.session).toBeNull();
    expect(handle.media?.tracks()).toEqual([]);
    expect(handle.content.open()).toBe(false);
    // The old account's join controls are inert from here.
    await handle.setDevice("microphone", true);
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    await handle.close();
  });

  it("sign-out invalidates the live call, releases media and releases the registry", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    expect(handle.media?.tracks()).toHaveLength(1);

    harness.emit(AUTH_SESSION_EVENT, {
      accountId: null,
      generation: 2,
      status: "credentials_absent",
      reason: "signed out",
    });
    await settle();

    expect(handle.state().code).toBe("ACCOUNT_CHANGED");
    expect(handle.state().recoverable).toBe(false);
    expect(harness.stops).toBeGreaterThan(0);
    expect(handle.media?.tracks()).toEqual([]);
    expect(handle.content.open()).toBe(false);
    expect(handle.consent?.recognitionAllowed()).toBe(false);
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "account-changed",
    });
    await handle.close();
  });

  it("keeps its own company uid and subscribes to nothing company-scoped", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(handle.account?.companyUid).toBe("cmp-indigo");
    expect(
      harness.listened.some((event) =>
        /company|workspace|navigat|sync-status/i.test(event),
      ),
    ).toBe(false);
    // A replay of this window's own generation is not an account change, so
    // main-window traffic can never re-attribute the call by accident.
    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-1",
      generation: 1,
      status: "active",
      reason: null,
    });
    await settle();
    expect(handle.account?.invalidated).toBe(false);
    expect(handle.state().code).not.toBe("ACCOUNT_CHANGED");
    await handle.close();
  });
});

// ── e2e 3 ────────────────────────────────────────────────────────────────────

describe("US-017 e2e 3: capture starts only from an explicit authorized action", () => {
  it("captures nothing on mount and nothing on a received knock", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.status).toBe("idle");
    expect(handle.state().media.camera.status).toBe("idle");

    // Nothing here subscribes to knocks; delivering one anyway must not reach
    // capture, and must not flip any device on.
    harness.emit("calls:knock", { knockId: "knk-1", from: "prs_2" });
    await settle();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.active).toBe(false);
    await handle.close();
  });

  it("captures on the explicit join control, per device", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(harness.getUserMedia.mock.calls[0]?.[0]).toEqual({ audio: true });
    expect(handle.state().media.microphone.active).toBe(true);

    await handle.setDevice("microphone", false);
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.media?.tracks()).toEqual([]);
    await handle.close();
  });

  it("failure path: a denied device shows recovery guidance and retries in place", async () => {
    let allow = false;
    const getUserMedia = vi.fn(async () => {
      if (!allow) throw denial();
      return {
        getTracks: () => [{ id: "video-1", kind: "video", stop: () => {} }],
      };
    });
    const harness = bench({ getUserMedia: getUserMedia as never });
    const handle = await startCallWindow(harness.deps);

    await handle.setDevice("camera", true);
    const denied = handle.state().media.camera;
    expect(denied.status).toBe("denied");
    expect(denied.code).toBe("MEDIA_PERMISSION_DENIED");
    expect(denied.recovery).toContain("System Settings");
    expect(denied.active).toBe(false);
    // A denial is not an intent: nothing is remembered as "on".
    expect(handle.state().preferences.camera).toBe(false);

    allow = true;
    await handle.setDevice("camera", true);
    expect(handle.state().media.camera.status).toBe("granted");
    expect(handle.state().media.camera.active).toBe(true);
    expect(handle.state().media.camera.code).toBeNull();
    await handle.close();
  });

  it("remembered choices store intent only, and never start capture on their own", async () => {
    const store = new Map<string, string>([
      [MEDIA_PREFS_KEY, JSON.stringify({ microphone: true, camera: true })],
    ]);
    const harness = bench({
      storage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
      },
    });
    const handle = await startCallWindow(harness.deps);

    expect(handle.state().preferences).toEqual({
      microphone: true,
      camera: true,
    });
    // Remembered intent is not authorization: still no capture until the
    // explicit control is used.
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.active).toBe(false);

    await handle.setDevice("microphone", false);
    const persisted = JSON.parse(store.get(MEDIA_PREFS_KEY) as string) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual({ microphone: false, camera: true });
    // Intent only: no device ids, no permission state, no identity.
    expect(Object.keys(persisted).sort()).toEqual(["camera", "microphone"]);
    await handle.close();
  });
});

// ── e2e 4 ────────────────────────────────────────────────────────────────────

describe("US-017 e2e 4: removal and expiry close media, data and content", () => {
  it("closes a removed peer's media and content delivery on the authoritative roster event", async () => {
    const call = wiredCall();
    await call.session.join(call.grant);
    call.fabric.admit(self, peerA, peerB);
    await settle();
    const pcA = call.connections.created[0]!;
    pcA.emitRemoteTrack(new FakeTrack("remote-a", "video"));
    expect(call.delivered).toEqual([`${labelOf(peerA)}:remote-a`]);
    expect(call.content.allows(labelOf(peerA))).toBe(true);

    call.fabric.revoke(peerA);
    await settle();

    expect(pcA.closed).toBe(true);
    expect(call.content.allows(labelOf(peerA))).toBe(false);
    expect(call.closes).toContainEqual({
      peerId: labelOf(peerA),
      reason: "peer-removed",
    });
    // The rest of the call is untouched.
    expect(call.content.open()).toBe(true);
    expect(call.content.allows(labelOf(peerB))).toBe(true);

    // No further content from the removed peer is delivered — and a removed
    // peer is never re-admitted by a later roster.
    const before = call.delivered.length;
    pcA.emitRemoteTrack(new FakeTrack("remote-a-late", "video"));
    call.fabric.admit(peerA);
    await settle();
    pcA.emitRemoteTrack(new FakeTrack("remote-a-later", "video"));
    await settle();
    expect(call.delivered).toHaveLength(before);
    expect(call.content.allows(labelOf(peerA))).toBe(false);
    await call.session.dispose();
  });

  it("stops traffic and closes content by the deadline when control goes silent", async () => {
    const call = wiredCall({ trafficStopMs: 10_000 });
    await call.session.join(call.grant);
    call.fabric.admit(self, peerA);
    await settle();
    const pc = call.connections.last;
    pc.emitRemoteTrack(new FakeTrack("remote-a", "video"));
    const before = call.delivered.length;
    expect(before).toBe(1);

    // Control says nothing at all from here: no roster, no renewal.
    call.scheduler.advance(9_000);
    await settle();
    expect(call.content.open()).toBe(true);

    call.scheduler.advance(1_500);
    await settle();

    expect(call.session.snapshot().trafficStopped).toBe(true);
    expect(call.content.open()).toBe(false);
    expect(call.closes).toContainEqual({
      peerId: null,
      reason: "traffic-stopped",
    });
    expect(call.connections.created.every((entry) => entry.closed)).toBe(true);

    pc.emitRemoteTrack(new FakeTrack("remote-a-late", "video"));
    await settle();
    expect(call.delivered).toHaveLength(before);
    await call.session.dispose();
  });

  it("failure path: an unrenewable expired grant stops traffic by its own expiry", async () => {
    const call = wiredCall();
    const scheduler = call.scheduler;
    // No traffic-stop budget at all: the grant's own expiry is the deadline.
    await call.session.join(
      grant({ expiresAt: scheduler.now() + 5_000, trafficStopMs: undefined }),
    );
    call.fabric.admit(self, peerA);
    await settle();
    expect(call.session.snapshot().trafficStopped).toBe(false);

    scheduler.advance(5_001);
    await settle();

    expect(call.session.snapshot().trafficStopped).toBe(true);
    expect(call.content.open()).toBe(false);
    expect(call.session.snapshot().peers).toEqual([]);
    await call.session.dispose();
    expect(scheduler.pending).toBe(0);
  });
});

// ── e2e 5 ────────────────────────────────────────────────────────────────────

describe("US-017 e2e 5: the consent-roster barrier tracks audio admission", () => {
  function gate() {
    const scheduler = new FakeScheduler();
    const consent = createConsentGate({
      clock: scheduler,
      selfPersonUid: self.personUid,
    });
    return { scheduler, consent };
  }

  function readyProof(
    overrides: Partial<Parameters<ReturnType<typeof gate>["consent"]["applyProof"]>[0]> = {},
  ) {
    return {
      revision: 1,
      consentEpoch: 1,
      rosterRevision: 2,
      processorId: null,
      participants: [self.personUid, peerA.personUid],
      acknowledged: [self.personUid, peerA.personUid],
      readyAt: 1_700_000_000_500,
      pausedAt: null,
      ...overrides,
    };
  }

  it("pauses on a new participant and resumes only on current-epoch readiness from everyone", () => {
    const { consent } = gate();
    consent.setEnabled(true);
    consent.observeRoster({
      rosterRevision: 2,
      participants: [self.personUid, peerA.personUid],
    });
    expect(consent.recognitionAllowed()).toBe(false);

    consent.applyProof(readyProof());
    expect(consent.recognitionAllowed()).toBe(true);
    expect(consent.snapshot().status).toBe("ready");

    // A new participant arrives: pause FIRST, before that audio can be
    // recognized under the old consent.
    consent.observeRoster({
      rosterRevision: 3,
      participants: [self.personUid, peerA.personUid, peerB.personUid],
    });
    expect(consent.recognitionAllowed()).toBe(false);
    expect(consent.snapshot().status).toBe("paused");
    expect(consent.snapshot().awaiting).toEqual([peerB.personUid]);
    // A paused epoch is never reused.
    expect(consent.nextConsentEpoch()).toBe(2);

    // A proof missing the newcomer's acknowledgement does NOT resume.
    consent.applyProof(
      readyProof({
        revision: 2,
        consentEpoch: 2,
        rosterRevision: 3,
        participants: [self.personUid, peerA.personUid, peerB.personUid],
        acknowledged: [self.personUid, peerA.personUid],
      }),
    );
    expect(consent.recognitionAllowed()).toBe(false);

    consent.applyProof(
      readyProof({
        revision: 3,
        consentEpoch: 2,
        rosterRevision: 3,
        participants: [self.personUid, peerA.personUid, peerB.personUid],
        acknowledged: [self.personUid, peerA.personUid, peerB.personUid],
      }),
    );
    expect(consent.recognitionAllowed()).toBe(true);
  });

  it("pauses on withdrawal, and a withdrawn epoch can never become ready again", () => {
    const { consent } = gate();
    consent.setEnabled(true);
    consent.observeRoster({
      rosterRevision: 2,
      participants: [self.personUid, peerA.personUid],
    });
    consent.applyProof(readyProof());
    expect(consent.recognitionAllowed()).toBe(true);

    consent.withdraw();
    expect(consent.recognitionAllowed()).toBe(false);
    expect(consent.snapshot().status).toBe("paused");
    expect(consent.nextConsentEpoch()).toBe(2);

    // Re-delivering the very same ready proof must not resurrect the epoch.
    consent.applyProof(readyProof());
    expect(consent.recognitionAllowed()).toBe(false);

    // Turning the control off is a withdrawal too. It PAUSES the proof rather
    // than forgetting it: the withdrawal has to name the epoch that is open,
    // and the re-enable has to propose the next one.
    consent.setEnabled(false);
    expect(consent.snapshot().status).toBe("off");
    expect(consent.snapshot().consentEpoch).toBe(1);
    consent.setEnabled(true);
    expect(consent.recognitionAllowed()).toBe(false);
    expect(consent.nextConsentEpoch()).toBe(2);
  });

  it("ignores delayed and reordered control events rather than applying them", () => {
    const { consent } = gate();
    consent.setEnabled(true);
    consent.observeRoster({
      rosterRevision: 3,
      participants: [self.personUid, peerA.personUid, peerB.personUid],
    });
    consent.applyProof(
      readyProof({
        consentEpoch: 2,
        rosterRevision: 3,
        participants: [self.personUid, peerA.personUid, peerB.personUid],
        acknowledged: [self.personUid, peerA.personUid, peerB.personUid],
      }),
    );
    expect(consent.recognitionAllowed()).toBe(true);

    // A roster delivery from before the current revision is a reordered
    // delivery: ignored, so it can neither shrink the roster nor pause us.
    consent.observeRoster({
      rosterRevision: 2,
      participants: [self.personUid, peerA.personUid],
    });
    expect(consent.snapshot().rosterRevision).toBe(3);
    expect(consent.recognitionAllowed()).toBe(true);

    // An older epoch, and a stale store revision of the current epoch, are
    // both ignored — neither can revoke nor re-grant recognition.
    consent.applyProof(
      readyProof({
        revision: 9,
        consentEpoch: 1,
        rosterRevision: 3,
        participants: [self.personUid],
        acknowledged: [],
        readyAt: null,
        pausedAt: 1_700_000_000_900,
      }),
    );
    expect(consent.snapshot().consentEpoch).toBe(2);
    expect(consent.recognitionAllowed()).toBe(true);

    consent.applyProof(
      readyProof({
        revision: 1,
        consentEpoch: 2,
        rosterRevision: 3,
        participants: [self.personUid, peerA.personUid, peerB.personUid],
        acknowledged: [self.personUid],
      }),
    );
    expect(consent.recognitionAllowed()).toBe(true);

    // A proof formed for an older roster is refused the same way.
    consent.applyProof(
      readyProof({
        revision: 5,
        consentEpoch: 3,
        rosterRevision: 2,
        participants: [self.personUid, peerA.personUid],
        acknowledged: [self.personUid, peerA.personUid],
      }),
    );
    expect(consent.snapshot().consentEpoch).toBe(2);
  });

  it("failure path: an undeliverable acknowledgement leaves transcription visibly paused", async () => {
    const { consent } = gate();
    consent.setEnabled(true);
    consent.observeRoster({
      rosterRevision: 2,
      participants: [self.personUid, peerA.personUid],
    });
    consent.applyProof(readyProof());
    expect(consent.recognitionAllowed()).toBe(true);
    consent.noteAcknowledgementUnavailable();
    expect(consent.recognitionAllowed()).toBe(false);
    expect(consent.snapshot().acknowledgementUnavailable).toBe(true);

    // And end to end through the window: hq-pro refuses the consent control
    // in this bench, so the barrier must stay paused and say so, never
    // optimistically ready.
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().transcription).toBe("off");

    await handle.setTranscription(true);
    expect(handle.state().transcription).toBe("paused");
    expect(handle.state().consentUnavailable).toBe(true);
    expect(handle.consent?.recognitionAllowed()).toBe(false);
    await handle.close();
  });
});
