import { describe, expect, it } from "vitest";

import type { OutboundSignal, PeerIdentity, TrackLike } from "./ports.js";
import { PeerTransport, TRANSPORT_TUNING, isPolite } from "./transport.js";
import {
  FakeConnectionFactory,
  FakeScheduler,
  FakeTrack,
} from "./testing.js";

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

function harness(self = alice, remote = bob) {
  const scheduler = new FakeScheduler();
  const connections = new FakeConnectionFactory();
  const sent: OutboundSignal[] = [];
  const counters: string[] = [];
  const tracks: TrackLike[] = [new FakeTrack("t-audio", "audio")];
  const remoteTracks: TrackLike[] = [];
  const transport = new PeerTransport({
    self,
    remote,
    connections,
    timers: scheduler,
    clock: scheduler,
    random: () => 0,
    localTracks: () => tracks,
    send: (signal) => sent.push(signal),
    onChange: () => undefined,
    onRemoteTrack: (_peer, track) => remoteTracks.push(track),
    count: (counter) => counters.push(counter),
  });
  return { scheduler, connections, sent, counters, transport, remoteTracks };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("perfect negotiation roles", () => {
  it("is deterministic and exactly one side is polite", () => {
    expect(isPolite(alice, bob)).toBe(true);
    expect(isPolite(bob, alice)).toBe(false);
  });
});

describe("PeerTransport", () => {
  it("attaches local tracks and offers on negotiationneeded", async () => {
    const { transport, connections, sent } = harness();
    transport.connect();
    await flush();
    expect(connections.created).toHaveLength(1);
    expect(sent.map((signal) => signal.type)).toEqual(["offer"]);
  });

  it("answers a remote offer and flushes buffered candidates in order", async () => {
    const { transport, connections, sent } = harness();
    transport.connect();
    await flush();
    sent.length = 0;

    // Candidates that arrive before the remote description are buffered.
    await transport.handleCandidate({ candidate: "c1" });
    await transport.handleCandidate({ candidate: "c2" });
    const pc = connections.last;
    expect(pc.addedCandidates).toHaveLength(0);

    pc.signalingState = "stable";
    await transport.handleDescription({ type: "offer", sdp: "remote" });

    expect(pc.addedCandidates.map((c) => c.candidate)).toEqual(["c1", "c2"]);
    expect(sent.map((signal) => signal.type)).toEqual(["answer"]);
  });

  it("impolite peer ignores a colliding offer; polite peer rolls back", async () => {
    const impolite = harness(bob, alice);
    impolite.transport.connect();
    await flush();
    impolite.sent.length = 0;
    expect(impolite.connections.last.signalingState).toBe("have-local-offer");
    await impolite.transport.handleDescription({ type: "offer", sdp: "glare" });
    expect(impolite.sent).toHaveLength(0);
    expect(impolite.counters).toContain("offerCollisionIgnored");

    const polite = harness(alice, bob);
    polite.transport.connect();
    await flush();
    polite.sent.length = 0;
    await polite.transport.handleDescription({ type: "offer", sdp: "glare" });
    expect(polite.sent.map((signal) => signal.type)).toEqual(["answer"]);
    expect(polite.counters).toContain("offerCollisionRolledBack");
  });

  it("drops a stray answer with no connection", async () => {
    const { transport, connections, counters } = harness();
    await transport.handleDescription({ type: "answer", sdp: "stray" });
    expect(connections.created).toHaveLength(0);
    expect(counters).toContain("strayAnswer");
  });

  it("restarts ICE with capped exponential backoff and then fails", async () => {
    const { transport, connections, scheduler, counters } = harness();
    transport.connect();
    await flush();
    const pc = connections.last;
    pc.signalingState = "stable";

    for (let attempt = 0; attempt < TRANSPORT_TUNING.maxIceRestarts; attempt += 1) {
      pc.setIceState("failed");
      scheduler.advance(TRANSPORT_TUNING.restartBackoffMaxMs + 1);
    }
    expect(pc.restarts).toBe(TRANSPORT_TUNING.maxIceRestarts);
    expect(
      counters.filter((counter) => counter === "iceRestart"),
    ).toHaveLength(TRANSPORT_TUNING.maxIceRestarts);

    // Budget exhausted: no further restarts, the peer is terminally failed.
    pc.setIceState("failed");
    scheduler.advance(TRANSPORT_TUNING.restartBackoffMaxMs + 1);
    expect(pc.restarts).toBe(TRANSPORT_TUNING.maxIceRestarts);
    expect(transport.snapshot().status).toBe("failed");
  });

  it("renegotiates from scratch when signaling is stuck mid-negotiation", async () => {
    const { transport, connections, scheduler } = harness();
    transport.connect();
    await flush();
    const first = connections.last;
    expect(first.signalingState).toBe("have-local-offer");

    first.setIceState("failed");
    scheduler.advance(TRANSPORT_TUNING.restartBackoffMaxMs + 1);

    expect(connections.created).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(transport.snapshot().restartAttempts).toBe(1);
  });

  it("escalates a lingering disconnect after the grace period", async () => {
    const { transport, connections, scheduler } = harness();
    transport.connect();
    await flush();
    const pc = connections.last;
    pc.signalingState = "stable";
    pc.setConnectionState("disconnected");
    expect(pc.restarts).toBe(0);
    scheduler.advance(TRANSPORT_TUNING.disconnectGraceMs + 1);
    scheduler.advance(TRANSPORT_TUNING.restartBackoffMaxMs + 1);
    expect(pc.restarts).toBe(1);
  });

  it("recovers a silent connection via the establishment watchdog", async () => {
    const { transport, connections, scheduler } = harness();
    transport.connect();
    await flush();
    const pc = connections.last;
    pc.signalingState = "stable";
    pc.connectionState = "connecting";
    scheduler.advance(TRANSPORT_TUNING.establishTimeoutMs + 1);
    scheduler.advance(TRANSPORT_TUNING.restartBackoffMaxMs + 1);
    expect(pc.restarts).toBe(1);
  });

  it("caps outbound trickle candidates at the budget", async () => {
    const { transport, connections, sent, counters } = harness();
    transport.connect();
    await flush();
    const pc = connections.last;
    for (let i = 0; i < TRANSPORT_TUNING.candidateBudget + 5; i += 1) {
      pc.emitCandidate({ candidate: `c${i}` });
    }
    expect(sent.filter((signal) => signal.type === "ice")).toHaveLength(
      TRANSPORT_TUNING.candidateBudget,
    );
    expect(counters).toContain("candidateBudgetExceeded");
  });

  it("releases connection, listeners and timers on close", async () => {
    const { transport, connections, scheduler, remoteTracks } = harness();
    transport.connect();
    await flush();
    const pc = connections.last;
    transport.close();
    expect(pc.closed).toBe(true);
    expect(pc.ontrack).toBeNull();
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onnegotiationneeded).toBeNull();
    expect(scheduler.pending).toBe(0);

    // A stale callback from the closed connection reaches nobody.
    pc.emitRemoteTrack(new FakeTrack("t-video", "video"));
    expect(remoteTracks).toHaveLength(0);
  });

  it("keeps snapshots content-free", async () => {
    const { transport, connections } = harness();
    transport.connect();
    await flush();
    connections.last.emitRemoteTrack(new FakeTrack("t-video", "video"));
    const snapshot = transport.snapshot();
    expect(snapshot.remoteTrackKinds).toEqual(["video"]);
    expect(JSON.stringify(snapshot)).not.toContain("sdp");
    expect(JSON.stringify(snapshot)).not.toContain("candidate");
  });
});
