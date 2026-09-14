import { describe, expect, it } from "vitest";
import type { CallBinding, CallGrant, PeerIdentity } from "./ports.js";
import { createCallSession, type CallSession, type TranscriptEvent } from "./session.js";
import { FakeConnectionFactory, FakeDataChannel, FakeMediaPort, FakeScheduler, FakeSignalingFabric, FakeTrack } from "./testing.js";
import { encodeTranscript, parseTranscript, TRANSCRIPT_MAX_BYTES, type TranscriptMessage } from "./transcript.js";
const binding: CallBinding = {
  companyUid: "cmp_indigo",
  roomId: "room_story",
  callId: "call_story",
  epoch: 3,
};

/** `alice < bob` lexically, so alice is polite and opens the control channel. */
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

/** The transport's own recovery budget, mirrored so the test stays explicit. */



const flush = (): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

function grant(rosterRevision: number, expiresAt: number): CallGrant {
  return {
    grantId: "grant_story",
    role: "participant",
    rosterRevision,
    expiresAt,
  };
}

interface Fixture {
  scheduler: FakeScheduler;
  fabric: FakeSignalingFabric;
  session: CallSession;
  connections: FakeConnectionFactory;
  media: FakeMediaPort;
}

function fixture(): Fixture {
  const scheduler = new FakeScheduler();
  const fabric = new FakeSignalingFabric(binding);
  const connections = new FakeConnectionFactory();
  const media = new FakeMediaPort([
    new FakeTrack("mic-1", "audio"),
    new FakeTrack("cam-1", "video"),
  ]);
  const session = createCallSession({
    binding,
    self: alice,
    sessionId: "sess-story",
    ports: {
      signaling: fabric.port(alice),
      media,
      connections,
      clock: scheduler,
      timers: scheduler,
      random: () => 0,
    },
  });
  return { scheduler, fabric, session, connections, media };
}

async function joined(): Promise<Fixture> {
  const fx = fixture();
  await fx.session.join(grant(1, fx.scheduler.now() + 600_000));
  fx.fabric.admit(alice, bob);
  await flush();
  return fx;
}


const message: TranscriptMessage = { kind: "transcript", version: 1, conversationId: "conv-1", streamId: "stream-1", segmentId: "segment-1", revision: 0, startMs: 0, endMs: 100, text: "Hello", final: false };
describe("transcript codec", () => {
  it("round-trips text, final revisions, and empty correction text", () => {
    for (const m of [message, {...message, revision: 2, final: true, text: ""}]) expect(parseTranscript(encodeTranscript(m))).toEqual(m);
  });
  it("rejects malformed, unbounded, identity-bearing and audio-bearing payloads", () => {
    for (const m of [null, [], "broken", "x".repeat(TRANSCRIPT_MAX_BYTES + 1),
      {...message, version: 2}, {...message, text: "x".repeat(4097)}, {...message, text: 12},
      {...message, conversationId: ""}, {...message, streamId: "x".repeat(129)},
      {...message, revision: -1}, {...message, revision: 1.5}, {...message, startMs: -1},
      {...message, endMs: Number.MAX_SAFE_INTEGER + 1}, {...message, startMs: 101},
      {...message, final: "true"}, {...message, personUid: "forged"}, {...message, audio: "bytes"}]) {
      expect(parseTranscript(m)).toBeNull();
    }
    expect(() => encodeTranscript({...message, text: "x".repeat(4097)})).toThrow("INVALID_TRANSCRIPT");
  });
});
describe("admitted transcript control delivery", () => {
  it("sends only on an open admitted channel and derives sender from its peer", async () => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    const seen: TranscriptEvent[] = [];
    let moderation = 0;
    fx.session.on("transcript", e => seen.push(e));
    fx.session.on("moderation", () => moderation++);
    expect(fx.session.sendTranscript("prs_bob dev_b", message)).toBe(false);
    channel.open();
    expect(fx.session.sendTranscript("prs_bob dev_b", message)).toBe(true);
    expect(channel.sent).toEqual([encodeTranscript(message)]);
    expect(fx.session.sendTranscript("unknown peer", message)).toBe(false);
    channel.deliver(encodeTranscript(message));
    expect(seen).toEqual([{sessionId: fx.session.sessionId, generation: fx.session.snapshot().generation, from: bob, message}]);
    expect(moderation).toBe(0);
    channel.deliver(JSON.stringify({...message, personUid: "forged"}));
    channel.deliver(JSON.stringify({...message, final: "yes"}));
    channel.deliver("x".repeat(TRANSCRIPT_MAX_BYTES + 1));
    expect(fx.session.sendTranscript("prs_bob dev_b", {...message, revision: -1})).toBe(false);
    expect(seen).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
    expect(JSON.stringify(fx.session.snapshot())).not.toContain('"text":"Hello"');
    await fx.session.dispose();
  });
  it.each(["revoked", "expired", "traffic", "leave"])("closes delivery after %s, including queued callbacks", async reason => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    channel.open();
    const queued = channel.onmessage!;
    let seen = 0;
    fx.session.on("transcript", () => seen++);
    if (reason === "revoked") fx.fabric.revoke(bob);
    if (reason === "expired") fx.scheduler.advance(600_000);
    if (reason === "traffic") {
      await fx.session.leave();
      await fx.session.join({...grant(1, fx.scheduler.now() + 600_000), trafficStopMs: 10});
      fx.fabric.admit(alice, bob);
      fx.scheduler.advance(10);
    }
    if (reason === "leave") await fx.session.leave();
    queued({data: encodeTranscript(message)});
    expect(fx.session.sendTranscript("prs_bob dev_b", message)).toBe(false);
    expect(seen).toBe(0);
    await fx.session.dispose();
  });
});
