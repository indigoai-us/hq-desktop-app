import { describe, expect, it } from "vitest";

import type {
  CallBinding,
  CallGrant,
  InboundSignal,
  PeerIdentity,
  SignalingPort,
} from "./ports.js";
import { createCallSession, type CallSession } from "./session.js";
import { TRANSPORT_TUNING } from "./transport.js";
import {
  FakeConnectionFactory,
  FakeMediaPort,
  FakeScheduler,
  FakeSignalingFabric,
  FakeTrack,
} from "./testing.js";

const binding: CallBinding = {
  companyUid: "cmp_indigo",
  roomId: "room_1",
  callId: "call_1",
  epoch: 3,
};

const alice: PeerIdentity = {
  personUid: "prs_alice",
  deviceId: "dev_a",
  peerKey: "key_a",
};
const bob: PeerIdentity = {
  personUid: "prs_bob",
  deviceId: "dev_b",
  peerKey: "key_b",
};
const mallory: PeerIdentity = {
  personUid: "prs_mallory",
  deviceId: "dev_m",
  peerKey: "key_m",
};

function grantFor(rosterRevision: number, expiresAt: number): CallGrant {
  return {
    grantId: "grant_1",
    role: "participant",
    rosterRevision,
    expiresAt,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Fixture {
  scheduler: FakeScheduler;
  fabric: FakeSignalingFabric;
  session: CallSession;
  connections: FakeConnectionFactory;
  media: FakeMediaPort;
}

function fixture(self: PeerIdentity = alice): Fixture {
  const scheduler = new FakeScheduler();
  const fabric = new FakeSignalingFabric(binding);
  const connections = new FakeConnectionFactory();
  const media = new FakeMediaPort([new FakeTrack(`${self.deviceId}-a`, "audio")]);
  const session = createCallSession({
    binding,
    self,
    sessionId: `sess-${self.deviceId}`,
    ports: {
      signaling: fabric.port(self),
      media,
      connections,
      clock: scheduler,
      timers: scheduler,
      random: () => 0,
    },
  });
  return { scheduler, fabric, session, connections, media };
}

describe("CallSession lifecycle", () => {
  it("moves idle -> joining -> joined -> idle -> disposed", async () => {
    const { session, scheduler } = fixture();
    expect(session.snapshot().phase).toBe("idle");
    await session.join(grantFor(1, scheduler.now() + 60_000));
    expect(session.snapshot().phase).toBe("joined");
    await session.leave();
    expect(session.snapshot().phase).toBe("idle");
    await session.dispose();
    expect(session.snapshot().phase).toBe("disposed");
  });

  it("refuses a second join and any join after dispose", async () => {
    const { session, scheduler } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    await expect(session.join(grantFor(1, scheduler.now()))).rejects.toThrow(
      /already joined/,
    );
    await session.dispose();
    await expect(session.join(grantFor(1, scheduler.now()))).rejects.toThrow(
      /disposed/,
    );
  });

  it("stamps every callback with the session id and generation", async () => {
    const { session, scheduler, fabric } = fixture();
    const events: string[] = [];
    session.on("state", (event) => {
      expect(event.sessionId).toBe("sess-dev_a");
      expect(event.snapshot.sessionId).toBe("sess-dev_a");
      events.push(`state:${event.generation}`);
    });
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    expect(events.every((event) => event.endsWith(":1"))).toBe(true);
  });
});

describe("admission authority", () => {
  it("drops signals from a peer that is not on the admitted roster", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice);
    await flush();

    const forged: InboundSignal = {
      binding,
      from: mallory,
      rosterRevision: fabric.rosterRevision,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "mallory" },
    };
    fabric.inject(alice, forged);
    await flush();

    const snapshot = session.snapshot();
    expect(snapshot.peers).toHaveLength(0);
    expect(connections.created).toHaveLength(0);
    expect(snapshot.diagnostics.unadmittedPeer).toBe(1);
  });

  it("rejects a signal whose binding does not match the session", async () => {
    const { session, scheduler, fabric } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();

    fabric.inject(alice, {
      binding: { ...binding, epoch: binding.epoch + 1 },
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "wrong-epoch" },
    });
    await flush();
    expect(session.snapshot().diagnostics.wrongBinding).toBe(1);
  });

  it("rejects a signal carrying a stale roster revision", async () => {
    const { session, scheduler, fabric } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();

    fabric.inject(alice, {
      binding,
      from: bob,
      rosterRevision: fabric.rosterRevision - 1,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "stale" },
    });
    await flush();
    expect(session.snapshot().diagnostics.staleRosterRevision).toBe(1);
  });

  it("tears down a peer that disappears from the roster", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    expect(session.snapshot().peers).toHaveLength(1);
    const pc = connections.last;

    fabric.revoke(bob);
    await flush();
    expect(session.snapshot().peers).toHaveLength(0);
    expect(pc.closed).toBe(true);
    expect(session.snapshot().diagnostics.peerRemovedFromRoster).toBe(1);
  });

  it("drops every connection when this device leaves the roster", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    const pc = connections.last;

    fabric.revoke(alice);
    await flush();
    expect(pc.closed).toBe(true);
    expect(session.snapshot().peers).toHaveLength(0);
    expect(session.snapshot().diagnostics.selfNotAdmitted).toBe(1);
  });
});

describe("simultaneous offers between two admitted peers", () => {
  it("settles on one stable connection without an offer-collision failure", async () => {
    const scheduler = new FakeScheduler();
    const fabric = new FakeSignalingFabric(binding);
    const build = (self: PeerIdentity) => {
      const connections = new FakeConnectionFactory();
      const session = createCallSession({
        binding,
        self,
        sessionId: `sess-${self.deviceId}`,
        ports: {
          signaling: fabric.port(self),
          media: new FakeMediaPort([
            new FakeTrack(`${self.deviceId}-a`, "audio"),
          ]),
          connections,
          clock: scheduler,
          timers: scheduler,
          random: () => 0,
        },
      });
      return { session, connections };
    };
    const a = build(alice);
    const b = build(bob);

    await a.session.join(grantFor(1, scheduler.now() + 60_000));
    await b.session.join(grantFor(1, scheduler.now() + 60_000));
    // Both are admitted at the same revision, so both offer at once.
    fabric.admit(alice, bob);
    for (let i = 0; i < 5; i += 1) await flush();

    const offers = fabric.sent.filter((signal) => signal.type === "offer");
    const answers = fabric.sent.filter((signal) => signal.type === "answer");
    expect(offers.length).toBeGreaterThanOrEqual(2);
    // Exactly one negotiation survives: the impolite side ignored the collision.
    expect(answers).toHaveLength(1);

    const aPeer = a.session.snapshot().peers[0];
    const bPeer = b.session.snapshot().peers[0];
    expect(aPeer?.polite).toBe(true);
    expect(bPeer?.polite).toBe(false);
    expect(a.session.snapshot().diagnostics.negotiationFailed).toBeUndefined();
    expect(b.session.snapshot().diagnostics.offerCollisionIgnored).toBe(1);
    expect(a.connections.created).toHaveLength(1);
    expect(b.connections.created).toHaveLength(1);
  });
});

describe("disposal and rejoin", () => {
  it("releases tracks, connections, timers and listeners on dispose", async () => {
    const { session, scheduler, fabric, connections, media } = fixture();
    const seen: string[] = [];
    session.on("state", (event) => seen.push(event.snapshot.phase));
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    const pc = connections.last;
    const track = media.tracks[0] as FakeTrack;

    await session.dispose();

    expect(pc.closed).toBe(true);
    expect(track.stopped).toBe(true);
    expect(scheduler.pending).toBe(0);
    const before = seen.length;
    fabric.admit(mallory);
    scheduler.advance(60_000);
    await flush();
    expect(seen).toHaveLength(before);
  });

  it("never invokes a listener registered on a disposed session", async () => {
    const { session, scheduler } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    await session.dispose();
    let called = 0;
    const off = session.on("state", () => {
      called += 1;
    });
    scheduler.advance(120_000);
    off();
    expect(called).toBe(0);
  });

  it("does not leak the previous session's events or media into a rejoin", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    const stalePc = connections.last;

    await session.leave();
    expect(stalePc.closed).toBe(true);

    const tracks: string[] = [];
    session.on("track", (event) => tracks.push(event.track.id));
    await session.join(grantFor(fabric.rosterRevision, scheduler.now() + 60_000));
    await flush();
    const afterRejoin = session.snapshot();
    expect(afterRejoin.generation).toBe(3);
    expect(afterRejoin.diagnostics.unadmittedPeer).toBeUndefined();

    // A callback from the previous generation's connection reaches nobody.
    stalePc.emitRemoteTrack(new FakeTrack("ghost", "video"));
    stalePc.setConnectionState("failed");
    await flush();
    expect(tracks).toHaveLength(0);
    expect(
      afterRejoin.peers.every((peer) => peer.restartAttempts === 0),
    ).toBe(true);
  });
});

describe("grant expiry", () => {
  it("stops traffic and drops connections at the traffic-stop deadline", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join({
      ...grantFor(1, scheduler.now() + 60_000),
      trafficStopMs: 5_000,
    });
    fabric.admit(alice, bob);
    await flush();
    const pc = connections.last;

    scheduler.advance(5_001);
    const snapshot = session.snapshot();
    expect(snapshot.trafficStopped).toBe(true);
    expect(pc.closed).toBe(true);
    expect(snapshot.peers).toHaveLength(0);
    expect(snapshot.errors.some((error) => error.code === "GRANT_EXPIRED")).toBe(
      true,
    );
  });

  it("keeps the call alive while control keeps reconciling", async () => {
    const { session, scheduler, fabric } = fixture();
    await session.join({
      ...grantFor(1, scheduler.now() + 600_000),
      trafficStopMs: 5_000,
    });
    fabric.admit(alice, bob);
    for (let tick = 0; tick < 4; tick += 1) {
      scheduler.advance(4_000);
      fabric.broadcastRoster();
      await flush();
    }
    expect(session.snapshot().trafficStopped).toBe(false);
    expect(session.snapshot().peers).toHaveLength(1);
  });
});

describe("snapshots", () => {
  it("never carry SDP, candidates or peer keys", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();
    connections.last.emitCandidate({ candidate: "a=candidate:secret" });
    await flush();

    const serialized = JSON.stringify(session.snapshot());
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sdp");
    expect(serialized).not.toContain(bob.peerKey);
    expect(session.snapshot().peers[0]?.peerId).toBe("prs_bob dev_b");
  });

  it("carry the admitted roster, key-free, not only the peers we hold", async () => {
    const { session, scheduler, fabric } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();

    // Downstream gates (content delivery, the consent barrier) must reason
    // about who is ADMITTED. `peers` is only who we currently hold a transport
    // to, which lags admission — consenting over that set would recognize the
    // audio of someone who has not yet connected and never acknowledged.
    expect(session.snapshot().admitted).toEqual([
      { personUid: alice.personUid, deviceId: alice.deviceId },
      { personUid: bob.personUid, deviceId: bob.deviceId },
    ]);
    expect(JSON.stringify(session.snapshot().admitted)).not.toContain(
      bob.peerKey,
    );
  });

  it("reports transport tuning that matches the ported prototype cap", () => {
    expect(TRANSPORT_TUNING.maxIceRestarts).toBe(5);
    expect(TRANSPORT_TUNING.restartBackoffMaxMs).toBe(15_000);
  });
});

describe("a join that fails after the roster arrived", () => {
  /** A port that admits a roster (so transports exist) and then rejects. */
  function failingPort(error: Error): {
    signaling: SignalingPort;
    stops: () => number;
  } {
    let stops = 0;
    return {
      signaling: {
        async start(handlers) {
          handlers.onRoster({
            rosterRevision: 2,
            peers: [alice, bob],
            trafficStopMs: 5_000,
          });
          throw error;
        },
        async send() {
          // never reached
        },
        async stop() {
          stops += 1;
        },
      },
      stops: () => stops,
    };
  }

  function failingFixture(error: Error) {
    const scheduler = new FakeScheduler();
    const connections = new FakeConnectionFactory();
    const track = new FakeTrack("dev_a-audio", "audio");
    const media = new FakeMediaPort([track]);
    const port = failingPort(error);
    const session = createCallSession({
      binding,
      self: alice,
      sessionId: "sess-fail",
      ports: {
        signaling: port.signaling,
        media,
        connections,
        clock: scheduler,
        timers: scheduler,
        random: () => 0,
      },
    });
    return { scheduler, connections, track, session, stops: port.stops };
  }

  it("tears down every transport, timer, track and the grant", async () => {
    const fail = failingFixture(new Error("START_FAILED"));
    await expect(
      fail.session.join(grantFor(2, fail.scheduler.now() + 60_000)),
    ).rejects.toThrow(/START_FAILED/);
    await flush();

    // The roster created a connection before the failure surfaced.
    expect(fail.connections.created.length).toBeGreaterThan(0);
    expect(fail.connections.created.every((pc) => pc.closed)).toBe(true);
    expect(fail.scheduler.pending).toBe(0);
    expect(fail.stops()).toBe(1);
    expect(fail.track.stopped).toBe(true);

    const snapshot = fail.session.snapshot();
    expect(snapshot.grantId).toBeNull();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.peers).toHaveLength(0);
    expect(
      snapshot.errors.some((error) => error.code === "SIGNALING_START_FAILED"),
    ).toBe(true);
  });

  it("records the failure without the error's own text", async () => {
    const fail = failingFixture(
      new Error("setRemoteDescription failed for sdp v=0 secret 10.0.0.1"),
    );
    await expect(
      fail.session.join(grantFor(2, fail.scheduler.now() + 60_000)),
    ).rejects.toThrow();
    await flush();

    const snapshot = fail.session.snapshot();
    const recorded = snapshot.errors.find(
      (error) => error.code === "SIGNALING_START_FAILED",
    );
    expect(recorded?.message).toBe("Operation failed.");
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sdp");
    expect(serialized).not.toContain("10.0.0.1");
  });
});

describe("inbound signal dedupe", () => {
  it("applies a redelivered offer once and counts the duplicate", async () => {
    const { session, scheduler, fabric } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await flush();

    const offer: InboundSignal = {
      binding,
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 5,
      type: "offer",
      payload: { type: "offer", sdp: "remote-offer" },
    };
    fabric.inject(alice, offer);
    await flush();
    fabric.inject(alice, { ...offer });
    await flush();

    const answers = fabric.sent.filter((signal) => signal.type === "answer");
    expect(answers).toHaveLength(1);
    expect(session.snapshot().diagnostics.duplicateSignal).toBe(1);

    // A newer sequence from the same sender is still applied.
    fabric.inject(alice, { ...offer, sequence: 6 });
    await flush();
    expect(fabric.sent.filter((signal) => signal.type === "answer")).toHaveLength(
      2,
    );
    expect(session.snapshot().diagnostics.duplicateSignal).toBe(1);
  });
});
