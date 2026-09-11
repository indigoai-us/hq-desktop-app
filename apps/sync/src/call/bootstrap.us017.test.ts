/**
 * US-017 — the call window wired to the active account.
 *
 * `auth.test.ts` and `permissions.test.ts` pin the units. This file pins the
 * wiring: that the identity gate stands in front of the signer and the join,
 * that a grant landing after an account switch is discarded rather than used,
 * and that no path through the bootstrap reaches `getUserMedia` on its own.
 */

import { describe, expect, it, vi } from "vitest";
import { verifyEnvelope } from "@hq/platform";
import { FakeConnectionFactory } from "@hq/meet-core/testing";

import { AUTH_SESSION_EVENT } from "./auth";
import {
  initialCallViewState,
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
} from "./bootstrap";
import { createDeviceSigner } from "./signer";
import type { CallWindowTarget } from "./target";

const SESSION_ID = "cmp-1:room-1:call-1:7";

function target(overrides: Partial<CallWindowTarget> = {}): CallWindowTarget {
  return {
    sessionId: SESSION_ID,
    companyUid: "cmp-1",
    roomId: "room-1",
    callId: "call-1",
    epoch: 7,
    self: { personUid: "prs_1", deviceId: "dev-1" },
    ...overrides,
  };
}

interface Bench {
  deps: CallWindowDeps;
  calls: Array<{ command: string; args?: Record<string, unknown> }>;
  commands: () => string[];
  argsOf: (command: string) => Record<string, unknown> | undefined;
  emit: (event: string, payload: unknown) => void;
  getUserMedia: ReturnType<typeof vi.fn>;
  whoami: ReturnType<typeof vi.fn>;
}

function bench(
  options: {
    generation?: number;
    personUid?: string | null;
    invoke?: CallInvoke;
    target?: CallWindowTarget;
  } = {},
): Bench {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    const custom = await options.invoke?.(command, args);
    if (custom !== undefined) return custom;
    if (command === "calls_take_pending_target") {
      return options.target ?? target();
    }
    if (command === "get_auth_session") {
      return {
        accountId: "acct-1",
        generation: options.generation ?? 1,
        status: "active",
        reason: null,
      };
    }
    if (command === "hq_pro_fetch") {
      const request = (args ?? {}) as { url?: unknown };
      // US-018: the window admits ITSELF before it can build a session, so the
      // admit round trip has to succeed even in the benches that are only
      // about the identity gate. Every OTHER hq-pro round trip still refuses
      // politely — this story needs no live signaling exchange.
      if (String(request.url ?? "") === "/v1/meet-native/signaling/admit") {
        return {
          status: 200,
          body: JSON.stringify({
            code: "OK",
            grant: {
              grantId: "grant-1",
              role: "participant",
              rosterRevision: 0,
              expiresAt: Date.now() + 600_000,
            },
            trafficStopMs: 10_000,
            controlPollMs: 1_000,
          }),
        };
      }
      return { status: 503, body: "{}" };
    }
    return null;
  };

  const whoami = vi.fn(async () =>
    options.personUid === null
      ? { ok: false as const, reason: "error" as const }
      : {
          ok: true as const,
          value: { personUid: options.personUid ?? "prs_1", email: "a@b.c" },
        },
  );
  const getUserMedia = vi.fn(async () => ({
    getTracks: () => [{ id: "audio-1", kind: "audio", stop: vi.fn() }],
  }));

  const deps: CallWindowDeps = {
    invoke,
    listen: async (event, handler) => {
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
    identity: { whoami: whoami as never },
    getUserMedia: getUserMedia as never,
    storage: null,
  };

  return {
    deps,
    calls,
    commands: () => calls.map((entry) => entry.command),
    argsOf: (command) =>
      calls.find((entry) => entry.command === command)?.args,
    emit: (event, payload) => {
      for (const handler of handlers.get(event) ?? []) handler({ payload });
    },
    getUserMedia,
    whoami,
  };
}

describe("identity gate", () => {
  it("pauses with a recoverable error and never mints a key when identity is unresolved", async () => {
    const createSigner = vi.fn();
    const harness = bench({
      personUid: "6f0a1e2c-1111-4222-8333-444455556666",
    });
    harness.deps.createSigner = createSigner as never;
    const handle = await startCallWindow(harness.deps);

    expect(handle.state().status).toBe("identity");
    expect(handle.state().code).toBe("IDENTITY_UNRESOLVED");
    expect(handle.state().recoverable).toBe(true);
    expect(handle.session).toBeNull();
    expect(createSigner).not.toHaveBeenCalled();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    // The window still holds the call: the registry entry must NOT be released
    // on a recoverable refusal, or the Retry would have nothing to join.
    expect(harness.commands()).not.toContain("calls_release");
    await handle.close();
  });

  it("joins on Retry once the canonical identity resolves", async () => {
    let personUid = "6f0a1e2c-1111-4222-8333-444455556666";
    const harness = bench();
    harness.deps.identity = {
      whoami: (async () => ({
        ok: true as const,
        value: { personUid },
      })) as never,
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.session).toBeNull();

    personUid = "prs_1";
    await handle.retryIdentity();
    expect(handle.session).not.toBeNull();
    expect(handle.state().status).not.toBe("identity");
    await handle.close();
  });

  it("refuses and releases when the account is not the one the grant names", async () => {
    const harness = bench({ personUid: "prs_2" });
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().status).toBe("error");
    expect(handle.state().code).toBe("IDENTITY_MISMATCH");
    expect(handle.state().recoverable).toBe(false);
    expect(handle.session).toBeNull();
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "identity_mismatch",
    });
    await handle.close();
  });
});

describe("account-generation binding", () => {
  it("invalidates the call, stops capture and releases on an account change", async () => {
    const stop = vi.fn();
    const harness = bench();
    harness.deps.getUserMedia = (async () => ({
      getTracks: () => [{ id: "audio-1", kind: "audio", stop }],
    })) as never;
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    expect(handle.media?.tracks()).toHaveLength(1);

    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-2",
      generation: 2,
      status: "active",
      reason: null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle.account?.invalidated).toBe(true);
    expect(handle.state().code).toBe("ACCOUNT_CHANGED");
    expect(stop).toHaveBeenCalled();
    expect(handle.media?.tracks()).toEqual([]);
    expect(handle.content.open()).toBe(false);
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "account-changed",
    });
    await handle.close();
  });

  it("ignores a replayed envelope for its own generation", async () => {
    const harness = bench({ generation: 4 });
    const handle = await startCallWindow(harness.deps);
    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-1",
      generation: 4,
      status: "active",
      reason: null,
    });
    expect(handle.account?.invalidated).toBe(false);
    expect(handle.state().code).not.toBe("ACCOUNT_CHANGED");
    await handle.close();
  });

  it("discards a grant that resolves after the account changed", async () => {
    const harness = bench();
    let signal: (() => void) | undefined;
    harness.deps.createSigner = (async () => {
      // The account switches while the device key is being minted, i.e. while
      // the join is in flight and its grant is still in the air.
      signal?.();
      return {
        peerKey: "d".repeat(64),
        publicKey: "e".repeat(43),
        sign: async () => "f".repeat(86),
      };
    }) as never;
    const started = startCallWindow(harness.deps);
    signal = () =>
      harness.emit(AUTH_SESSION_EVENT, {
        accountId: "acct-2",
        generation: 9,
        status: "active",
        reason: null,
      });
    const handle = await started;

    expect(handle.account?.invalidated).toBe(true);
    // The session built under the old account never became usable.
    expect(handle.session).toBeNull();
    expect(handle.media?.tracks()).toEqual([]);
    await handle.close();
  });

  it("holds its own company uid and subscribes to nothing company-scoped", async () => {
    const listened: string[] = [];
    const harness = bench();
    const inner = harness.deps.listen;
    harness.deps.listen = async (event, handler) => {
      listened.push(event);
      return inner(event, handler);
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.account?.companyUid).toBe("cmp-1");
    expect(
      listened.some((event) => /company|workspace|navigat/i.test(event)),
    ).toBe(false);
    await handle.close();
  });
});

describe("capture is explicit", () => {
  it("captures nothing on mount, and nothing on a received knock", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(harness.getUserMedia).not.toHaveBeenCalled();

    // Nothing in this window subscribes to knocks, and delivering one anyway
    // must not reach capture.
    harness.emit("calls:knock", { knockId: "knk-1" });
    await Promise.resolve();
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.status).toBe("idle");
    await handle.close();
  });

  it("captures only from the explicit join control, and republishes in place", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    const refresh = vi.spyOn(
      handle.session as { refreshLocalTracks: () => void },
      "refreshLocalTracks",
    );

    await handle.setDevice("microphone", true);
    expect(harness.getUserMedia).toHaveBeenCalledTimes(1);
    expect(handle.state().media.microphone.active).toBe(true);
    expect(handle.state().preferences.microphone).toBe(true);
    expect(refresh).toHaveBeenCalled();

    await handle.setDevice("microphone", false);
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.state().preferences.microphone).toBe(false);
    await handle.close();
  });

  it("stops every local track on leave", async () => {
    const stop = vi.fn();
    const harness = bench();
    harness.deps.getUserMedia = (async () => ({
      getTracks: () => [{ id: "audio-1", kind: "audio", stop }],
    })) as never;
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    await handle.leave("leave-button");
    expect(stop).toHaveBeenCalled();
    expect(handle.content.open()).toBe(false);
    await handle.close();
  });
});

describe("native wiring", () => {
  it("publishes the auth session envelope to the call window, not only the shell", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("../../src-tauri/src/commands/auth.rs", import.meta.url),
      "utf8",
    );
    // Without this emit the call window never learns about a sign-out or an
    // account switch, and a live call outlives the account that authorized it.
    expect(source).toContain("commands::calls::CALL_WINDOW_LABEL");
    expect(source).toContain('pub const AUTH_SESSION_CHANGED_EVENT: &str = "auth:session-changed"');
    expect(AUTH_SESSION_EVENT).toBe("auth:session-changed");
  });
});

describe("transcription barrier", () => {
  it("starts off and never reports ready without a consent acknowledgement", async () => {
    const harness = bench();
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().transcription).toBe("off");

    await handle.setTranscription(true);
    // hq-pro refuses in this bench, so the acknowledgement is unavailable:
    // the barrier must stay visibly paused rather than optimistically ready.
    expect(handle.state().transcription).toBe("paused");
    expect(handle.state().consentUnavailable).toBe(true);
    expect(handle.consent?.recognitionAllowed()).toBe(false);

    await handle.setTranscription(false);
    expect(handle.state().transcription).toBe("off");
    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// Review fixes: a LIVE bench.
//
// The benches above refuse every hq-pro round trip, which is enough to pin the
// identity gate but says nothing about what the window does once a roster, a
// consent proof and a traffic stop actually arrive. This bench answers
// `hq_pro_fetch` per path, so the real `createHqSignalingPort` polls a real
// reconcile and `startCallWindow` folds real snapshots.
// ---------------------------------------------------------------------------

const CONSENT_PATH = "/v1/meet-native/completion/consent";
const RECONCILE_PATH = "/v1/meet-native/signaling/reconcile";
/** US-018: the window admits ITSELF here before it can join. */
const ADMIT_PATH = "/v1/meet-native/signaling/admit";

const PEER = { personUid: "prs_2", deviceId: "dev-2", peerKey: "c".repeat(64) };
const PEER_ID = `${PEER.personUid} ${PEER.deviceId}`;

interface ReconcileBody {
  rosterRevision: number;
  peers: Array<{ personUid: string; deviceId: string; peerKey: string }>;
  expiresAt?: number;
  trafficStopMs?: number;
  controlPollMs?: number;
}

interface LiveBench extends Bench {
  /** Bodies posted to the consent route, newest last. */
  consents: Array<Record<string, unknown>>;
  /** Bodies posted to the admit route, newest last. */
  admits: Array<Record<string, unknown>>;
  /** Raw Ed25519 public key of the window's device signer, base64url. */
  publicKey: () => string;
  /** `peerKey` (keyId) of the window's device signer. */
  peerKey: () => string;
  reconciles: () => number;
}

function liveBench(options: {
  /** Reconcile body per tick, or null to refuse (control goes quiet). */
  roster: (tick: number, selfPeerKey: string) => ReconcileBody | null;
  /** Consent response value, given the posted body. Null refuses. */
  consent?: (
    body: Record<string, unknown>,
    index: number,
  ) => Record<string, unknown> | null;
  /** Overrides folded into the top level of the admit response. */
  grant?: Record<string, unknown>;
  /** Overrides folded into the admit response's nested `grant` object. */
  grantOverrides?: Record<string, unknown>;
  getUserMedia?: CallWindowDeps["getUserMedia"];
}): LiveBench {
  const consents: Array<Record<string, unknown>> = [];
  const admits: Array<Record<string, unknown>> = [];
  let reconciles = 0;
  let publicKey = "";
  let peerKey = "";

  const harness = bench({
    target: target(),
    invoke: async (command, args) => {
      if (command !== "hq_pro_fetch") return undefined;
      const request = (args ?? {}) as { url?: unknown; body?: unknown };
      const url = String(request.url ?? "");
      const body = JSON.parse(String(request.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (url === ADMIT_PATH) {
        admits.push(body);
        return {
          status: 200,
          body: JSON.stringify({
            code: "OK",
            grant: {
              grantId: "grant-1",
              role: "participant",
              rosterRevision: 0,
              expiresAt: Date.now() + 600_000,
              ...options.grantOverrides,
            },
            renewAfterMs: 1,
            trafficStopMs: 10_000,
            controlPollMs: 5,
            ...options.grant,
          }),
        };
      }
      if (url === CONSENT_PATH) {
        consents.push(body);
        const value = options.consent?.(body, consents.length - 1) ?? {};
        if (value === null) return { status: 503, body: "{}" };
        return { status: 200, body: JSON.stringify(value) };
      }
      if (url === RECONCILE_PATH) {
        reconciles += 1;
        const next = options.roster(reconciles, peerKey);
        if (!next) return { status: 503, body: "{}" };
        return { status: 200, body: JSON.stringify({ code: "OK", ...next }) };
      }
      // Signals and everything else succeed quietly: this bench is about the
      // control plane, not about media negotiation.
      return { status: 200, body: JSON.stringify({ code: "OK" }) };
    },
  });

  harness.deps.createSigner = (async () => {
    const signer = await createDeviceSigner();
    publicKey = signer.publicKey;
    peerKey = signer.peerKey;
    return signer;
  }) as never;
  harness.deps.connections = new FakeConnectionFactory();
  if (options.getUserMedia) harness.deps.getUserMedia = options.getUserMedia;

  return {
    ...harness,
    consents,
    admits,
    publicKey: () => publicKey,
    peerKey: () => peerKey,
    reconciles: () => reconciles,
  };
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const BACKEND_CONSENT_FIELDS = [
  "acknowledged",
  "callId",
  "companyUid",
  "consentEpoch",
  "deviceId",
  "epoch",
  "grantId",
  "kind",
  "personUid",
  "peerKey",
  "processorId",
  "roomId",
  "rosterRevision",
  "sentAt",
  "signature",
  "version",
].sort();

function roster(revision: number, selfPeerKey: string): ReconcileBody {
  return {
    rosterRevision: revision,
    peers: [
      { personUid: "prs_1", deviceId: "dev-1", peerKey: selfPeerKey },
      PEER,
    ],
    expiresAt: Date.now() + 600_000,
  };
}

describe("consent acknowledgements are signed backend envelopes", () => {
  it("posts exactly the backend consentControl field set, signed by the device key", async () => {
    const harness = liveBench({ roster: (_tick, key) => roster(1, key) });
    const handle = await startCallWindow(harness.deps);
    await until(
      () => handle.state().peerCount > 0 || harness.reconciles() > 0,
      "the first roster",
    );

    await handle.setTranscription(true);
    expect(harness.consents).toHaveLength(1);
    const posted = harness.consents[0] as Record<string, unknown>;

    // Exactly the fields `consentInput` accepts — it is a zod strictObject, so
    // a missing field and an extra field are both outright refusals.
    expect(Object.keys(posted).sort()).toEqual(BACKEND_CONSENT_FIELDS);
    expect(posted).toMatchObject({
      version: "hq-meet/1",
      kind: "consentControl",
      companyUid: "cmp-1",
      roomId: "room-1",
      callId: "call-1",
      epoch: 7,
      personUid: "prs_1",
      deviceId: "dev-1",
      peerKey: harness.peerKey(),
      grantId: "grant-1",
      consentEpoch: 1,
      rosterRevision: 1,
      processorId: null,
      acknowledged: true,
    });
    expect(typeof posted.sentAt).toBe("number");

    // The signature is the whole point: the backend derives the acknowledging
    // actor from it, never from `personUid` in the body.
    await expect(
      verifyEnvelope(posted, harness.publicKey()),
    ).resolves.toBeUndefined();

    // ...and it is a signature over THIS envelope, not a constant.
    await expect(
      verifyEnvelope({ ...posted, acknowledged: false }, harness.publicKey()),
    ).rejects.toThrow();
    await handle.leave();
    await handle.close();
  });

  it("withdraws at the open epoch, carrying that proof's processor", async () => {
    const harness = liveBench({
      roster: (_tick, key) => roster(1, key),
      consent: (body) => ({
        revision: 1,
        consentEpoch: body.consentEpoch,
        rosterRevision: 1,
        processorId: "processor",
        participants: ["prs_1", "prs_2"],
        acknowledged: ["prs_1"],
        readyAt: null,
        pausedAt: null,
      }),
    });
    const handle = await startCallWindow(harness.deps);
    await until(() => harness.reconciles() > 0, "the first roster");
    await handle.setTranscription(true);
    expect(harness.consents[0]).toMatchObject({
      consentEpoch: 1,
      processorId: null,
    });

    await handle.setTranscription(false);
    const withdrawal = harness.consents.at(-1) as Record<string, unknown>;
    // Epoch 1, not 2: the backend pauses the proof that is open, and refuses a
    // withdrawal naming an epoch that does not exist yet.
    expect(withdrawal.consentEpoch).toBe(1);
    expect(withdrawal.acknowledged).toBe(false);
    // The proof was opened for "processor"; an amendment claiming no processor
    // is refused as `STALE_EPOCH`.
    expect(withdrawal.processorId).toBe("processor");
    await expect(
      verifyEnvelope(withdrawal, harness.publicKey()),
    ).resolves.toBeUndefined();

    // Re-enabling must open the NEXT epoch, never reuse the paused one.
    await handle.setTranscription(true);
    expect(harness.consents.at(-1)).toMatchObject({
      consentEpoch: 2,
      acknowledged: true,
    });
    await handle.leave();
    await handle.close();
  });

  it("sends at most one acknowledgement per epoch and roster generation", async () => {
    const harness = liveBench({
      roster: (_tick, key) => roster(1, key),
      consent: (body) => ({
        revision: 1,
        consentEpoch: body.consentEpoch,
        rosterRevision: 1,
        processorId: null,
        // The other participant has not acknowledged, so the barrier stays
        // paused and the auto-ack condition holds on EVERY later snapshot.
        participants: ["prs_1", "prs_2"],
        acknowledged: ["prs_1"],
        readyAt: null,
        pausedAt: null,
      }),
    });
    const handle = await startCallWindow(harness.deps);
    await until(() => harness.reconciles() > 0, "the first roster");
    await handle.setTranscription(true);
    expect(handle.consent?.recognitionAllowed()).toBe(false);

    const before = harness.reconciles();
    await until(
      () => harness.reconciles() > before + 12,
      "a dozen more snapshots",
    );
    // One explicit acknowledgement, and at most one automatic re-send for the
    // epoch/roster generation — not one per poll against a rate-limited plane.
    expect(harness.consents.length).toBeLessThanOrEqual(2);
    expect(handle.state().transcription).toBe("paused");
    await handle.leave();
    await handle.close();
  });
});

describe("the content gate survives a recoverable traffic stop", () => {
  it("re-opens when control comes back and membership is rebuilt", async () => {
    let quiet = false;
    const harness = liveBench({
      grant: { trafficStopMs: 30, controlPollMs: 5 },
      roster: (_tick, key) =>
        quiet ? null : { ...roster(1, key), trafficStopMs: 30 },
    });
    const handle = await startCallWindow(harness.deps);
    await until(
      () => handle.content.allows(PEER_ID),
      "the peer to be admitted for content",
    );

    // Control goes quiet: the watchdog stops traffic while the grant is still
    // perfectly valid.
    quiet = true;
    await until(
      () => handle.session?.snapshot().trafficStopped === true,
      "the traffic stop",
    );
    expect(handle.content.open()).toBe(false);

    // Control returns and the roster is rebuilt. This is a live call: it must
    // render again rather than stay permanently blank.
    quiet = false;
    await until(
      () => handle.content.open() && handle.content.allows(PEER_ID),
      "content delivery to re-open",
    );
    await handle.leave();
    await handle.close();
  });

  it("stays closed for good when the grant itself expired", async () => {
    // Long enough that content is reliably established first even on a loaded
    // machine, short enough that the expiry still lands inside `until`'s bound.
    const expiresAt = Date.now() + 600;
    let expired = false;
    const harness = liveBench({
      grant: { trafficStopMs: undefined, controlPollMs: 5 },
      grantOverrides: { expiresAt },
      roster: (_tick, key) =>
        expired
          ? { ...roster(2, key), expiresAt: Date.now() + 600_000 }
          : { ...roster(1, key), expiresAt },
    });
    const handle = await startCallWindow(harness.deps);
    await until(() => handle.content.allows(PEER_ID), "the peer's content");

    await until(
      () => handle.session?.snapshot().trafficStopped === true,
      "the grant to expire",
    );
    expect(handle.content.open()).toBe(false);

    // Even a healthy reconcile carrying a brand new expiry must not resurrect
    // content that an expired grant closed — a renewal is a new grant, and a
    // new grant is a new gate.
    expired = true;
    const before = harness.reconciles();
    await until(
      () => harness.reconciles() > before + 6,
      "several healthy reconciles",
    );
    expect(handle.content.open()).toBe(false);
    await handle.leave();
    await handle.close();
  });
});

describe("our own admission is authoritative too", () => {
  it("closes content and stops capture when the roster drops this device", async () => {
    const stop = vi.fn();
    let revoked = false;
    const harness = liveBench({
      roster: (_tick, key) =>
        revoked
          ? { rosterRevision: 2, peers: [PEER], expiresAt: Date.now() + 600_000 }
          : roster(1, key),
      getUserMedia: (async () => ({
        getTracks: () => [{ id: "audio-1", kind: "audio", stop }],
      })) as never,
    });
    const handle = await startCallWindow(harness.deps);
    await handle.setDevice("microphone", true);
    await until(() => handle.content.allows(PEER_ID), "the peer's content");
    expect(handle.media?.tracks()).toHaveLength(1);

    revoked = true;
    await until(() => !handle.content.open(), "the call-wide content close");
    // A revoked participant whose camera stayed on is exactly the failure the
    // gate exists to prevent.
    expect(stop).toHaveBeenCalled();
    expect(handle.media?.tracks()).toEqual([]);
    expect(handle.state().code).toBe("ADMISSION_REVOKED");
    await handle.leave();
    await handle.close();
  });
});

describe("the consent roster is the admitted roster", () => {
  it("counts an admitted participant we hold no transport to", async () => {
    const harness = liveBench({
      roster: (_tick, key) => ({
        rosterRevision: 1,
        peers: [
          { personUid: "prs_1", deviceId: "dev-1", peerKey: key },
          PEER,
          { personUid: "prs_3", deviceId: "dev-3", peerKey: "e".repeat(64) },
        ],
        expiresAt: Date.now() + 600_000,
      }),
    });
    const handle = await startCallWindow(harness.deps);
    await until(
      () => (handle.consent?.snapshot().awaiting.length ?? 0) > 0,
      "the consent roster",
    );
    // Everyone the roster ADMITS is someone whose audio must not be recognized
    // without their consent — including anyone we have not connected to yet.
    expect(handle.consent?.snapshot().awaiting).toEqual([
      "prs_1",
      "prs_2",
      "prs_3",
    ]);
    await handle.leave();
    await handle.close();
  });
});

describe("authority pauses rather than ending the call", () => {
  it("blocks new consent acknowledgements while a refresh is unavailable", async () => {
    const harness = liveBench({ roster: (_tick, key) => roster(1, key) });
    const handle = await startCallWindow(harness.deps);
    await until(() => harness.reconciles() > 0, "the first roster");

    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-1",
      generation: 1,
      status: "refresh_temporarily_unavailable",
      reason: "offline",
    });
    // The call is NOT over: media already flowing runs to its grant's expiry.
    expect(handle.account?.invalidated).toBe(false);
    expect(handle.state().authorityPaused).toBe(true);
    expect(handle.state().code).not.toBe("ACCOUNT_CHANGED");

    await handle.setTranscription(true);
    expect(harness.consents).toHaveLength(0);
    expect(handle.state().consentUnavailable).toBe(true);

    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-1",
      generation: 1,
      status: "active",
      reason: null,
    });
    expect(handle.state().authorityPaused).toBe(false);
    await handle.setTranscription(false);
    await handle.setTranscription(true);
    expect(harness.consents.length).toBeGreaterThan(0);
    await handle.leave();
    await handle.close();
  });
});

describe("join controls require a resolved identity", () => {
  it("reports identity as unresolved until the gate answers, and gates the shell on it", async () => {
    const fs = await import("node:fs/promises");
    // `connecting` is published BEFORE the identity gate runs, so a shell that
    // enabled its controls on status alone would hand the microphone to a
    // window that has not proved whose account it is.
    expect(initialCallViewState().identityResolved).toBe(false);

    let personUid = "6f0a1e2c-1111-4222-8333-444455556666";
    const harness = bench();
    harness.deps.identity = {
      whoami: (async () => ({ ok: true as const, value: { personUid } })) as never,
    };
    const handle = await startCallWindow(harness.deps);
    expect(handle.state().status).toBe("identity");
    expect(handle.state().identityResolved).toBe(false);

    personUid = "prs_1";
    await handle.retryIdentity();
    expect(handle.state().identityResolved).toBe(true);

    const shell = await fs.readFile(
      new URL("./CallShell.svelte", import.meta.url),
      "utf8",
    );
    const controls = shell.slice(
      shell.indexOf("const controlsEnabled"),
      shell.indexOf("const denial"),
    );
    expect(controls).toContain("view.identityResolved");
    expect(controls).toContain("view.authorityPaused");
    await handle.close();
  });
});

// ---------------------------------------------------------------------------
// US-018 — the window admits itself.
//
// The opener has no device key, so it cannot mint a grant this window could
// sign against. The window mints its key, signs its own `admit`, and only then
// joins with the grant the backend issued against that key.
// ---------------------------------------------------------------------------

describe("the call window admits itself", () => {
  it("signs admit with its own device key and joins with the returned grant", async () => {
    const harness = liveBench({ roster: (_tick, key) => roster(1, key) });
    const handle = await startCallWindow(harness.deps);
    await until(() => harness.admits.length > 0, "the admit");

    const posted = harness.admits[0] as Record<string, unknown>;
    expect(posted).toMatchObject({
      version: "hq-meet/1",
      kind: "control",
      operation: "admit",
      companyUid: "cmp-1",
      roomId: "room-1",
      callId: "call-1",
      epoch: 7,
      personUid: "prs_1",
      deviceId: "dev-1",
    });
    // The signer's OWN key pair — peerKey is derived from publicKey, and the
    // backend records publicKey as the admission proof.
    expect(posted.peerKey).toBe(harness.peerKey());
    expect(posted.publicKey).toBe(harness.publicKey());
    // No opener-supplied grant exists to smuggle in.
    expect(posted.grantId).toBeUndefined();
    expect(posted.knockId).toBeUndefined();
    expect(posted.capabilityId).toBeUndefined();
    // Throws unless the signature verifies against the window's own key.
    await expect(
      verifyEnvelope(posted, harness.publicKey()),
    ).resolves.toBeUndefined();

    // The grant the session runs on is the one admit returned.
    await until(
      () => handle.session?.snapshot().grantId === "grant-1",
      "the admitted grant",
    );
    await handle.leave();
    await handle.close();
  });

  it("carries an accepted knock's capability into the admit", async () => {
    const harness = liveBench({ roster: (_tick, key) => roster(1, key) });
    const inner = harness.deps.invoke as CallInvoke;
    harness.deps.invoke = ((command, args) =>
      command === "calls_take_pending_target"
        ? Promise.resolve(
            target({ knock: { knockId: "knk-1", capabilityId: "cap-1" } }),
          )
        : inner(command, args)) as CallInvoke;
    const handle = await startCallWindow(harness.deps);
    await until(() => harness.admits.length > 0, "the admit");
    expect(harness.admits[0]).toMatchObject({
      knockId: "knk-1",
      capabilityId: "cap-1",
    });
    await handle.leave();
    await handle.close();
  });

  it("refuses to join when admit is refused, and releases the registry entry", async () => {
    const harness = bench({
      invoke: async (command, args) => {
        if (command !== "hq_pro_fetch") return undefined;
        const url = String(((args ?? {}) as { url?: unknown }).url ?? "");
        if (url === "/v1/meet-native/signaling/admit") {
          return {
            status: 403,
            body: JSON.stringify({ code: "COMPANY_ACCESS_DENIED" }),
          };
        }
        return { status: 503, body: "{}" };
      },
    });
    const handle = await startCallWindow(harness.deps);
    expect(handle.session).toBeNull();
    expect(handle.state().status).toBe("error");
    expect(handle.state().code).toBe("COMPANY_ACCESS_DENIED");
    expect(harness.argsOf("calls_release")).toEqual({
      sessionId: SESSION_ID,
      reason: "admit-refused",
    });
    await handle.close();
  });

  it("discards an admit that lands after the account changed", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reachedAdmit: () => void = () => {};
    const admitStarted = new Promise<void>((resolve) => {
      reachedAdmit = resolve;
    });
    const harness = bench({
      invoke: async (command, args) => {
        if (command !== "hq_pro_fetch") return undefined;
        const url = String(((args ?? {}) as { url?: unknown }).url ?? "");
        if (url === "/v1/meet-native/signaling/admit") {
          reachedAdmit();
          await gate;
          return {
            status: 200,
            body: JSON.stringify({
              code: "OK",
              grant: {
                grantId: "grant-late",
                role: "participant",
                rosterRevision: 0,
                expiresAt: Date.now() + 600_000,
              },
            }),
          };
        }
        return { status: 503, body: "{}" };
      },
    });
    const started = startCallWindow(harness.deps);
    // The switch lands while the admit is still in the air.
    await admitStarted;
    harness.emit(AUTH_SESSION_EVENT, {
      accountId: "acct-2",
      generation: 2,
      status: "active",
      reason: null,
    });
    release!();
    const handle = await started;

    // The grant belongs to an account that is already gone: no session, and the
    // window is in its terminal account-changed state.
    expect(handle.session).toBeNull();
    expect(handle.state().code).toBe("ACCOUNT_CHANGED");
    await handle.close();
  });
});
