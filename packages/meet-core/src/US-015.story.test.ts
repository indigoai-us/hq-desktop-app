/**
 * US-015 story acceptance tests - "Extract a session-owned P2P call engine".
 *
 * Story-level regression cover for the three PRD e2e statements plus the named
 * failure and authorization paths. These drive only the public surface of
 * `@hq/meet-core` (`createCallSession`, its events and snapshots) through the
 * deterministic fakes in `@hq/meet-core/testing`: no real timers, no network,
 * and nothing imported from hq-meet or hq-pro.
 */

import { describe, expect, it } from "vitest";

import type {
  CallBinding,
  CallGrant,
  InboundSignal,
  PeerIdentity,
  SignalingHandlers,
  SignalingPort,
} from "./ports.js";
import { createCallSession, type CallSession } from "./session.js";
import {
  FakeConnectionFactory,
  FakeMediaPort,
  FakeScheduler,
  FakeSignalingFabric,
  FakeTrack,
} from "./testing.js";

const binding: CallBinding = {
  companyUid: "cmp_indigo",
  roomId: "room_story",
  callId: "call_story",
  epoch: 7,
};

const alice: PeerIdentity = {
  personUid: "prs_alice",
  deviceId: "dev_a",
  peerKey: "key_alice",
};
const bob: PeerIdentity = {
  personUid: "prs_bob",
  deviceId: "dev_b",
  peerKey: "key_bob",
};
const mallory: PeerIdentity = {
  personUid: "prs_mallory",
  deviceId: "dev_m",
  peerKey: "key_mallory",
};

function grantFor(rosterRevision: number, expiresAt: number): CallGrant {
  return {
    grantId: "grant_story",
    role: "participant",
    rosterRevision,
    expiresAt,
  };
}

/**
 * Drain the microtask queue (the fakes negotiate through `queueMicrotask`).
 * No real timer is ever armed, so the whole suite is clock-driven.
 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

interface Fixture {
  scheduler: FakeScheduler;
  fabric: FakeSignalingFabric;
  session: CallSession;
  connections: FakeConnectionFactory;
  media: FakeMediaPort;
  /** Handlers captured at each `SignalingPort.start()`, oldest first. */
  starts: SignalingHandlers[];
}

function fixture(self: PeerIdentity = alice): Fixture {
  const scheduler = new FakeScheduler();
  const fabric = new FakeSignalingFabric(binding);
  const connections = new FakeConnectionFactory();
  const media = new FakeMediaPort([
    new FakeTrack(`${self.deviceId}-audio`, "audio"),
  ]);
  const inner = fabric.port(self);
  const starts: SignalingHandlers[] = [];
  // Capture the handlers each join installs so a later test can replay a
  // previous generation's callback after the session has moved on.
  const signaling: SignalingPort = {
    async start(handlers, grant) {
      starts.push(handlers);
      await inner.start(handlers, grant);
    },
    send: (signal) => inner.send(signal),
    stop: () => inner.stop(),
  };
  const session = createCallSession({
    binding,
    self,
    sessionId: `story-${self.deviceId}`,
    ports: {
      signaling,
      media,
      connections,
      clock: scheduler,
      timers: scheduler,
      random: () => 0,
    },
  });
  return { scheduler, fabric, session, connections, media, starts };
}

describe("US-015: Extract a session-owned P2P call engine", () => {
  it("establishes one stable connection when two admitted peers offer at once", async () => {
    const scheduler = new FakeScheduler();
    const fabric = new FakeSignalingFabric(binding);
    const build = (self: PeerIdentity) => {
      const connections = new FakeConnectionFactory();
      const session = createCallSession({
        binding,
        self,
        sessionId: `story-${self.deviceId}`,
        ports: {
          signaling: fabric.port(self),
          media: new FakeMediaPort([
            new FakeTrack(`${self.deviceId}-audio`, "audio"),
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
    // Admitted in the same revision: both sides start negotiating at once.
    fabric.admit(alice, bob);
    await settle(40);

    // Exactly one negotiation survives the collision, on one connection a side.
    expect(
      fabric.sent.filter((signal) => signal.type === "offer").length,
    ).toBeGreaterThanOrEqual(2);
    expect(fabric.sent.filter((signal) => signal.type === "answer")).toHaveLength(
      1,
    );
    expect(a.connections.created).toHaveLength(1);
    expect(b.connections.created).toHaveLength(1);
    expect(a.connections.created[0]?.closed).toBe(false);
    expect(b.connections.created[0]?.closed).toBe(false);

    const aPeers = a.session.snapshot().peers;
    const bPeers = b.session.snapshot().peers;
    expect(aPeers).toHaveLength(1);
    expect(bPeers).toHaveLength(1);
    // Roles are symmetric and decided from identity, so exactly one side yields.
    expect(aPeers[0]?.polite).toBe(true);
    expect(bPeers[0]?.polite).toBe(false);
    expect(aPeers[0]?.status).not.toBe("failed");
    expect(bPeers[0]?.status).not.toBe("failed");

    const aDiagnostics = a.session.snapshot().diagnostics;
    const bDiagnostics = b.session.snapshot().diagnostics;
    expect(bDiagnostics.offerCollisionIgnored).toBe(1);
    expect(aDiagnostics.negotiationFailed).toBeUndefined();
    expect(bDiagnostics.negotiationFailed).toBeUndefined();
    expect(aDiagnostics.strayAnswer).toBeUndefined();
    expect(bDiagnostics.strayAnswer).toBeUndefined();

    await a.session.dispose();
    await b.session.dispose();
  });

  it("gives a publishing non-admitted peer neither membership nor media", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    const tracks: string[] = [];
    const states: number[] = [];
    session.on("track", (event) => tracks.push(event.track.id));
    session.on("state", (event) => states.push(event.snapshot.peers.length));

    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const admittedConnections = connections.created.length;

    // Mallory attaches a port and publishes as hard as it can. Publishing is
    // not admission: the fabric refuses to route for an unadmitted sender.
    const malloryPort = fabric.port(mallory);
    await malloryPort.start(
      { onSignal: () => undefined, onRoster: () => undefined, onError: () => undefined },
      grantFor(fabric.rosterRevision, scheduler.now() + 60_000),
    );
    await malloryPort.send({
      to: alice,
      type: "offer",
      payload: { type: "offer", sdp: "mallory-offer" },
    });
    await malloryPort.send({
      to: alice,
      type: "ice",
      payload: { candidate: "a=candidate:mallory" },
    });
    await settle();

    expect(fabric.forged).toHaveLength(2);
    const snapshot = session.snapshot();
    expect(snapshot.peers.map((peer) => peer.personUid)).toEqual(["prs_bob"]);
    expect(snapshot.peers.some((peer) => peer.personUid === "prs_mallory")).toBe(
      false,
    );
    // No membership, no new connection, no media, for the unadmitted peer.
    expect(connections.created).toHaveLength(admittedConnections);
    expect(tracks).toHaveLength(0);
    expect(states.every((count) => count <= 1)).toBe(true);

    await session.dispose();
  });

  it("keeps a previous session's events and media out of a rejoined call", async () => {
    const { session, scheduler, fabric, connections, starts } = fixture();
    const tracks: string[] = [];
    session.on("track", (event) => tracks.push(event.track.id));

    // Two full join/leave cycles before the call we actually care about.
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await session.join(
        grantFor(fabric.rosterRevision, scheduler.now() + 60_000),
      );
      fabric.admit(alice, bob);
      await settle();
      expect(session.snapshot().peers).toHaveLength(1);
      await session.leave();
      expect(session.snapshot().peers).toHaveLength(0);
    }
    const stalePc = connections.last;
    expect(stalePc.closed).toBe(true);
    const staleHandlers = starts[0];
    expect(staleHandlers).toBeDefined();

    await session.join(grantFor(fabric.rosterRevision, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const live = session.snapshot();
    expect(live.phase).toBe("joined");
    expect(live.peers).toHaveLength(1);
    const livePc = connections.last;
    expect(livePc).not.toBe(stalePc);
    tracks.length = 0;

    // Everything the previous generation could still say, said now.
    stalePc.emitRemoteTrack(new FakeTrack("ghost-video", "video"));
    stalePc.setConnectionState("failed");
    stalePc.setIceState("failed");
    staleHandlers?.onRoster({
      rosterRevision: fabric.rosterRevision + 5,
      peers: [alice, bob, mallory],
    });
    staleHandlers?.onSignal({
      binding,
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 99,
      type: "offer",
      payload: { type: "offer", sdp: "ghost-offer" },
    });
    scheduler.advance(30_000);
    await settle();

    const after = session.snapshot();
    expect(tracks).toHaveLength(0);
    expect(after.peers.map((peer) => peer.personUid)).toEqual(["prs_bob"]);
    // The live peer carries none of the dead connection's media, and the dead
    // connection's own recovery never runs again.
    expect(after.peers[0]?.remoteTrackKinds).toEqual([]);
    expect(stalePc.restarts).toBe(0);
    expect(livePc.restarts).toBe(connections.last.restarts);
    expect(after.diagnostics.staleRosterCallback).toBeGreaterThanOrEqual(1);
    expect(after.diagnostics.staleSignalCallback).toBeGreaterThanOrEqual(1);

    await session.dispose();
  });

  it("drops and counts a forged signal without creating a connection or track", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    const tracks: string[] = [];
    session.on("track", (event) => tracks.push(event.track.id));
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice);
    await settle();

    const forged: InboundSignal = {
      binding,
      from: mallory,
      rosterRevision: fabric.rosterRevision,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "forged-offer" },
    };
    fabric.inject(alice, forged);
    fabric.inject(alice, { ...forged, sequence: 2, type: "ice", payload: { candidate: "a=candidate:forged" } });
    await settle();

    const snapshot = session.snapshot();
    expect(snapshot.diagnostics.unadmittedPeer).toBe(2);
    expect(snapshot.peers).toHaveLength(0);
    expect(connections.created).toHaveLength(0);
    expect(tracks).toHaveLength(0);

    await session.dispose();
  });

  it("rejects signals with the wrong binding or a stale roster revision", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const beforeConnections = connections.created.length;

    fabric.inject(alice, {
      binding: { ...binding, callId: "call_other" },
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "other-call" },
    });
    fabric.inject(alice, {
      binding: { ...binding, epoch: binding.epoch + 1 },
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 2,
      type: "offer",
      payload: { type: "offer", sdp: "next-epoch" },
    });
    fabric.inject(alice, {
      binding,
      from: bob,
      rosterRevision: fabric.rosterRevision - 1,
      sequence: 3,
      type: "offer",
      payload: { type: "offer", sdp: "stale-revision" },
    });
    await settle();

    const diagnostics = session.snapshot().diagnostics;
    expect(diagnostics.wrongBinding).toBe(2);
    expect(diagnostics.staleRosterRevision).toBe(1);
    expect(connections.created).toHaveLength(beforeConnections);

    await session.dispose();
  });

  it("closes a revoked peer's media when the roster removes it", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    const tracks: string[] = [];
    session.on("track", (event) => tracks.push(event.track.id));
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const pc = connections.last;
    pc.emitRemoteTrack(new FakeTrack("bob-video", "video"));
    await settle();
    expect(tracks).toEqual(["bob-video"]);

    fabric.revoke(bob);
    await settle();

    expect(pc.closed).toBe(true);
    const snapshot = session.snapshot();
    expect(snapshot.peers).toHaveLength(0);
    expect(snapshot.diagnostics.peerRemovedFromRoster).toBe(1);

    // Media from the revoked peer's dead connection reaches nobody.
    pc.emitRemoteTrack(new FakeTrack("bob-video-2", "video"));
    await settle();
    expect(tracks).toEqual(["bob-video"]);

    await session.dispose();
  });

  it("stops traffic at the deadline when control never comes back", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join({
      ...grantFor(1, scheduler.now() + 600_000),
      trafficStopMs: 5_000,
    });
    fabric.admit(alice, bob);
    await settle();
    const pc = connections.last;
    expect(session.snapshot().trafficStopped).toBe(false);

    // Control goes quiet: no roster update ever arrives again.
    scheduler.advance(5_001);
    await settle();

    const snapshot = session.snapshot();
    expect(snapshot.trafficStopped).toBe(true);
    expect(snapshot.peers).toHaveLength(0);
    expect(pc.closed).toBe(true);
    expect(snapshot.diagnostics.trafficStop).toBe(1);
    expect(snapshot.errors.some((error) => error.code === "GRANT_EXPIRED")).toBe(
      true,
    );

    // Traffic stays stopped: later signals are refused, not negotiated.
    const sentBefore = fabric.sent.length;
    fabric.inject(alice, {
      binding,
      from: bob,
      rosterRevision: fabric.rosterRevision,
      sequence: 7,
      type: "offer",
      payload: { type: "offer", sdp: "after-stop" },
    });
    await settle();
    expect(session.snapshot().diagnostics.trafficStopped).toBeGreaterThanOrEqual(
      1,
    );
    expect(fabric.sent).toHaveLength(sentBefore);

    await session.dispose();
  });

  it("releases tracks, timers, connections and listeners on dispose", async () => {
    const { session, scheduler, fabric, connections, media } = fixture();
    const states: string[] = [];
    const tracks: string[] = [];
    const errors: string[] = [];
    session.on("state", (event) => states.push(event.snapshot.phase));
    session.on("track", (event) => tracks.push(event.track.id));
    session.on("error", (event) => errors.push(event.code));

    await session.join({
      ...grantFor(1, scheduler.now() + 600_000),
      trafficStopMs: 5_000,
    });
    fabric.admit(alice, bob);
    await settle();
    const pc = connections.last;
    const localTrack = media.tracks[0] as FakeTrack;
    expect(scheduler.pending).toBeGreaterThan(0);

    await session.dispose();

    expect(session.snapshot().phase).toBe("disposed");
    expect(pc.closed).toBe(true);
    expect(localTrack.stopped).toBe(true);
    expect(scheduler.pending).toBe(0);

    // Callbacks registered before dispose never fire after it.
    const stateCount = states.length;
    const errorCount = errors.length;
    fabric.admit(mallory);
    fabric.broadcastRoster();
    pc.emitRemoteTrack(new FakeTrack("post-dispose", "video"));
    pc.setConnectionState("failed");
    scheduler.advance(600_000);
    await settle();
    expect(states).toHaveLength(stateCount);
    expect(errors).toHaveLength(errorCount);
    expect(tracks).toHaveLength(0);
    expect(scheduler.pending).toBe(0);
  });

  it("starts a new generation on rejoin and counts old-generation signals as stale", async () => {
    const { session, scheduler, fabric, starts } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const firstGeneration = session.snapshot().generation;
    expect(firstGeneration).toBe(1);
    const firstHandlers = starts[0];

    await session.leave();
    await session.join(grantFor(fabric.rosterRevision, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();

    const rejoined = session.snapshot();
    expect(rejoined.generation).toBeGreaterThan(firstGeneration);
    expect(starts).toHaveLength(2);

    firstHandlers?.onSignal({
      binding,
      from: bob,
      rosterRevision: rejoined.rosterRevision,
      sequence: 1,
      type: "offer",
      payload: { type: "offer", sdp: "old-generation" },
    });
    firstHandlers?.onError("OLD", "old generation error");
    await settle();

    const after = session.snapshot();
    expect(after.diagnostics.staleSignalCallback).toBe(1);
    expect(after.diagnostics.staleErrorCallback).toBe(1);
    expect(after.errors).toHaveLength(0);
    expect(after.generation).toBe(rejoined.generation);

    await session.dispose();
  });

  it("serializes a snapshot that carries no SDP, candidate or peer-key text", async () => {
    const { session, scheduler, fabric, connections } = fixture();
    await session.join(grantFor(1, scheduler.now() + 60_000));
    fabric.admit(alice, bob);
    await settle();
    const pc = connections.last;
    pc.emitCandidate({ candidate: "a=candidate:1 1 udp 2 10.0.0.1 4444 typ host" });
    pc.emitRemoteTrack(new FakeTrack("bob-video", "video"));
    await settle();

    const serialized = JSON.stringify(session.snapshot());
    expect(serialized).not.toContain("sdp");
    expect(serialized).not.toContain("candidate");
    expect(serialized).not.toContain("offer-");
    expect(serialized).not.toContain("answer-");
    expect(serialized).not.toContain(bob.peerKey);
    // The only device key in a snapshot is this device's own canonical
    // identity, echoed back to the host that supplied it; no peer entry and no
    // diagnostic counter carries a key.
    expect(JSON.stringify(session.snapshot().peers)).not.toContain("key_");
    expect(JSON.stringify(session.snapshot().diagnostics)).not.toContain("key_");
    expect(serialized.split("key_alice")).toHaveLength(2);
    expect(session.snapshot().peers[0]?.peerId).toBe("prs_bob dev_b");

    await session.dispose();
  });

  it("documents the pinned HQ Meet provenance commit", async () => {
    // The package compiles with `types: []` and stays host-agnostic, so the
    // node builtin is reached through a computed specifier rather than a
    // static import that would pull DOM/node typings into the build.
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as {
      readFileSync(path: URL, encoding: string): string;
    };
    const provenance = fs.readFileSync(
      new URL("../PROVENANCE.md", import.meta.url),
      "utf8",
    );
    expect(provenance).toContain(
      "eaaf1c5abe3d6c502a06c96e92640bb867fb327b",
    );
    expect(provenance).toContain("hq-meet");
  });
});
