import { describe, expect, it } from "vitest";

import type { CallsApi, Json } from "@hq/platform";
import type {
  CallBinding,
  CallGrant,
  InboundSignal,
  PeerIdentity,
  RosterUpdate,
  SignalingHandlers,
} from "./ports.js";
import {
  createHqSignalingPort,
  decodePayload,
  encodePayload,
  type EnvelopeSigner,
} from "./hq-signaling.js";
import { FakeScheduler } from "./testing.js";

/** The fake scheduler's fixed epoch, so grants can be expressed against it. */
const T0 = 1_700_000_000_000;

const binding: CallBinding = {
  companyUid: "cmp_indigo",
  roomId: "room_1",
  callId: "call_1",
  epoch: 3,
};
const self: PeerIdentity = {
  personUid: "prs_alice",
  deviceId: "dev_a",
  peerKey: "key_a",
};
const bob: PeerIdentity = {
  personUid: "prs_bob",
  deviceId: "dev_b",
  peerKey: "key_b",
};
const grant: CallGrant = {
  grantId: "grant_1",
  role: "participant",
  rosterRevision: 7,
  expiresAt: T0 + 60_000,
};

interface ControlCall {
  operation: string;
  body: Record<string, unknown>;
}

/**
 * A fake CallsApi. Only the two methods this port uses are implemented; every
 * other member throws so an accidental new dependency is loud, not silent.
 */
function fakeCallsApi(
  reconcile: (call: number) => Json,
): {
  api: CallsApi;
  controls: ControlCall[];
  signals: { signal: Json; signature: string }[];
  failNextSend: () => void;
} {
  const controls: ControlCall[] = [];
  const signals: { signal: Json; signature: string }[] = [];
  let reconciles = 0;
  let failSend = false;
  const forbidden = () => {
    throw new Error("unexpected CallsApi use");
  };
  const api = new Proxy({} as CallsApi, {
    get(_target, property) {
      if (property === "contractVersion") return "hq-meet/1";
      if (property === "signalingControl") {
        return async (operation: string, body: Record<string, unknown>) => {
          controls.push({ operation, body });
          if (operation !== "reconcile") return { ok: true as const, value: {} };
          reconciles += 1;
          return { ok: true as const, value: reconcile(reconciles) };
        };
      }
      if (property === "sendSignal") {
        return async (request: { signal: Json; signature: string }) => {
          if (failSend) {
            failSend = false;
            return {
              ok: false as const,
              code: "RATE_LIMITED",
              message: "Too many signals.",
            };
          }
          signals.push(request);
          return { ok: true as const, value: {} };
        };
      }
      return forbidden;
    },
  });
  return {
    api,
    controls,
    signals,
    failNextSend: () => {
      failSend = true;
    },
  };
}

const signer: EnvelopeSigner = {
  async sign(envelope) {
    // A stand-in for the host's Ed25519 signature over signedBytes(envelope).
    return `sig-${String(envelope.kind)}-${String(envelope.sentAt)}`;
  },
};

function collector() {
  const rosters: RosterUpdate[] = [];
  const signals: InboundSignal[] = [];
  const errors: { code: string; message: string }[] = [];
  const handlers: SignalingHandlers = {
    onRoster: (roster) => rosters.push(roster),
    onSignal: (signal) => signals.push(signal),
    onError: (code, message) => errors.push({ code, message }),
  };
  return { handlers, rosters, signals, errors };
}

function signalEnvelope(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "hq-meet/1",
    kind: "signal",
    ...binding,
    personUid: bob.personUid,
    deviceId: bob.deviceId,
    peerKey: bob.peerKey,
    targetPersonUid: self.personUid,
    targetDeviceId: self.deviceId,
    grantId: "grant_b",
    rosterRevision: 7,
    sequence: 1,
    type: "offer",
    payload: encodePayload({ type: "offer", sdp: "remote-sdp" }),
    sentAt: 10,
    ...extra,
  };
}

describe("payload codec", () => {
  it("round-trips descriptions and candidates through base64", () => {
    const description = { type: "offer", sdp: "v=0\r\na=x" };
    expect(decodePayload(encodePayload(description))).toEqual(description);
    const candidate = { candidate: "a=candidate:1", sdpMLineIndex: 0 };
    expect(decodePayload(encodePayload(candidate))).toEqual(candidate);
    // Padding is exercised at every length modulus.
    for (const value of ["a", "ab", "abc", "abcd"]) {
      expect(decodePayload(encodePayload(value))).toBe(value);
    }
  });
});

describe("createHqSignalingPort", () => {
  it("reconciles immediately, surfaces roster and decoded signals", async () => {
    const backend = fakeCallsApi(() => ({
      code: "OK",
      signals: [signalEnvelope()],
      eventIds: ["evt_1"],
      rosterRevision: 7,
      peers: [self, bob],
      serverTime: 100,
      expiresAt: 60_100,
      trafficStopMs: 5_000,
      controlPollMs: 1_000,
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
      requestId: () => "req_1",
    });
    const sink = collector();
    await port.start(sink.handlers, grant);

    expect(backend.controls[0]?.operation).toBe("reconcile");
    expect(backend.controls[0]?.body).toMatchObject({
      version: "hq-meet/1",
      kind: "control",
      companyUid: binding.companyUid,
      callId: binding.callId,
      epoch: binding.epoch,
      personUid: self.personUid,
      grantId: "grant_1",
      signature: "sig-control-1700000000000",
    });
    expect(sink.rosters[0]).toMatchObject({
      rosterRevision: 7,
      grantExpiresAt: 60_100,
      trafficStopMs: 5_000,
    });
    expect(sink.rosters[0]?.peers).toHaveLength(2);
    expect(sink.signals[0]?.from).toEqual(bob);
    expect(sink.signals[0]?.payload).toEqual({ type: "offer", sdp: "remote-sdp" });
    expect(sink.signals[0]?.binding).toEqual(binding);

    await port.stop();
  });

  it("acks delivered signal ids on the next reconcile", async () => {
    const backend = fakeCallsApi((call) => ({
      code: "OK",
      signals: call === 1 ? [signalEnvelope()] : [],
      eventIds: call === 1 ? ["evt_1", "evt_2"] : [],
      rosterRevision: 7,
      peers: [self],
      controlPollMs: 1_000,
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
    });
    await port.start(collector().handlers, grant);

    scheduler.advance(1_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(backend.controls[1]?.body.ackIds).toEqual(["evt_1", "evt_2"]);

    await port.stop();
  });

  it("drops signals addressed to another device", async () => {
    const backend = fakeCallsApi(() => ({
      code: "OK",
      signals: [signalEnvelope({ targetDeviceId: "dev_other" })],
      eventIds: ["evt_1"],
      rosterRevision: 7,
      peers: [self, bob],
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
    });
    const sink = collector();
    await port.start(sink.handlers, grant);
    expect(sink.signals).toHaveLength(0);
    await port.stop();
  });

  it("renews before the grant expires", async () => {
    const backend = fakeCallsApi(() => ({
      code: "OK",
      signals: [],
      eventIds: [],
      rosterRevision: 7,
      peers: [self],
      renewAfterMs: 2_000,
      controlPollMs: 1_000,
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
      defaultRenewAfterMs: 2_000,
    });
    // The lease expires 5s out and renewAfterMs is 2s, so renew is due at +3s.
    await port.start(collector().handlers, {
      ...grant,
      expiresAt: scheduler.now() + 5_000,
    });
    expect(backend.controls.map((call) => call.operation)).toEqual([
      "reconcile",
    ]);

    for (let tick = 0; tick < 3; tick += 1) {
      scheduler.advance(1_000);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(backend.controls.map((call) => call.operation)).toContain("renew");
    await port.stop();
  });

  it("signs outbound signals and reports a backend refusal content-free", async () => {
    const backend = fakeCallsApi(() => ({
      code: "OK",
      signals: [],
      eventIds: [],
      rosterRevision: 9,
      peers: [self, bob],
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
    });
    const sink = collector();
    await port.start(sink.handlers, grant);

    await port.send({
      to: bob,
      type: "offer",
      payload: { type: "offer", sdp: "local-sdp" },
    });
    const sent = backend.signals[0];
    expect(sent?.signature).toBe("sig-signal-1700000000000");
    expect(sent?.signal).toMatchObject({
      kind: "signal",
      targetPersonUid: bob.personUid,
      targetDeviceId: bob.deviceId,
      grantId: "grant_1",
      rosterRevision: 9,
      sequence: 1,
      type: "offer",
    });
    expect(decodePayload(String(sent?.signal.payload))).toEqual({
      type: "offer",
      sdp: "local-sdp",
    });

    backend.failNextSend();
    await port.send({ to: bob, type: "ice", payload: { candidate: "c1" } });
    expect(sink.errors).toContainEqual({
      code: "RATE_LIMITED",
      message: "Too many signals.",
    });

    await port.stop();
  });

  it("stops polling and refuses to send after stop", async () => {
    const backend = fakeCallsApi(() => ({
      code: "OK",
      signals: [],
      eventIds: [],
      rosterRevision: 7,
      peers: [self],
      controlPollMs: 1_000,
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
    });
    await port.start(collector().handlers, grant);
    await port.stop();
    expect(scheduler.pending).toBe(0);

    const before = backend.controls.length;
    scheduler.advance(10_000);
    await port.send({ to: bob, type: "ice", payload: { candidate: "c1" } });
    expect(backend.controls).toHaveLength(before);
    expect(backend.signals).toHaveLength(0);
  });

  it("surfaces a queue-expired reconcile as a content-free error", async () => {
    const backend = fakeCallsApi(() => ({
      code: "SIGNAL_QUEUE_EXPIRED",
      signals: [],
      eventIds: [],
      rosterRevision: 7,
      peers: [],
    }));
    const scheduler = new FakeScheduler();
    const port = createHqSignalingPort(backend.api, signer, {
      binding,
      self,
      clock: scheduler,
      timers: scheduler,
    });
    const sink = collector();
    await port.start(sink.handlers, grant);
    expect(sink.errors[0]?.code).toBe("SIGNAL_QUEUE_EXPIRED");
    await port.stop();
  });
});
