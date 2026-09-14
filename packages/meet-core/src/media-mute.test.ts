/**
 * The mute guard and the moderation seam (US-020).
 *
 * The invariant under test: while a kind is muted, NO sender on ANY connection
 * ever holds an enabled track of that kind — across `replaceTrack`, a device
 * change, renegotiation, an ICE restart and a full reconnect. And: no inbound
 * control message can enable local media, whoever sent it.
 */

import { describe, expect, it } from "vitest";

import type { CallBinding, CallGrant, PeerIdentity } from "./ports.js";
import { createCallSession, type CallSession } from "./session.js";
import { MODERATION_CHANNEL_LABEL, parseModeration } from "./moderation.js";
import { createSpeakingTracker } from "./speaking.js";
import {
  FakeConnectionFactory,
  FakeDataChannel,
  FakeMediaPort,
  FakeScheduler,
  FakeSignalingFabric,
  FakeTrack,
} from "./testing.js";

const binding: CallBinding = {
  companyUid: "cmp_indigo",
  roomId: "room_1",
  callId: "call_1",
  epoch: 1,
};

// `alice < bob` lexically, so alice is the polite peer and opens the channel.
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

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function grant(rosterRevision: number, expiresAt: number): CallGrant {
  return { grantId: "grant_1", role: "participant", rosterRevision, expiresAt };
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
    sessionId: "sess-a",
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

/** Every kind any sender on any connection currently carries. */
function sentKinds(connections: FakeConnectionFactory): string[] {
  return connections.created
    .flatMap((pc) => pc.getSenders())
    .map((sender) => sender.track?.kind)
    .filter((kind): kind is string => typeof kind === "string")
    .sort();
}

async function joined(): Promise<Fixture> {
  const fx = fixture();
  await fx.session.join(grant(1, fx.scheduler.now() + 600_000));
  fx.fabric.admit(alice, bob);
  await flush();
  return fx;
}

describe("mute never sends", () => {
  it("clears the sender for a muted kind and refuses to re-attach it", async () => {
    const fx = await joined();
    expect(sentKinds(fx.connections)).toEqual(["audio", "video"]);

    fx.session.setLocalTrackEnabled("audio", false);
    await flush();
    expect(sentKinds(fx.connections)).toEqual(["video"]);
    expect(fx.session.snapshot().mutedKinds).toEqual(["audio"]);

    // A plain republish (the path every control takes) must not undo it.
    fx.session.refreshLocalTracks();
    await flush();
    expect(sentKinds(fx.connections)).toEqual(["video"]);
  });

  it("keeps the mute across a device change (replaceLocalTrack)", async () => {
    const fx = await joined();
    fx.session.setLocalTrackEnabled("audio", false);
    await flush();

    fx.session.replaceLocalTrack("audio", new FakeTrack("mic-2", "audio"));
    await flush();
    expect(sentKinds(fx.connections)).toEqual(["video"]);

    // The camera device change DOES land - only the muted kind is withheld.
    fx.session.replaceLocalTrack("video", new FakeTrack("cam-2", "video"));
    await flush();
    const videoTracks = fx.connections.created
      .flatMap((pc) => pc.getSenders())
      .filter((sender) => sender.track?.kind === "video")
      .map((sender) => sender.track?.id);
    expect(videoTracks).toContain("cam-2");
    expect(sentKinds(fx.connections)).toEqual(["video"]);
  });

  it("keeps the mute across a renegotiation and a reconnect", async () => {
    const fx = await joined();
    fx.session.setLocalTrackEnabled("audio", false);
    fx.session.setLocalTrackEnabled("video", false);
    await flush();
    expect(sentKinds(fx.connections)).toEqual([]);

    // Renegotiation: a fresh roster re-runs connect() on the live transport.
    fx.fabric.admit(alice, bob);
    await flush();
    expect(sentKinds(fx.connections)).toEqual([]);

    // Reconnect: the connection fails and the transport builds a new one.
    fx.connections.last.setConnectionState("failed");
    fx.scheduler.advance(TRANSPORT_RESTART_MS);
    await flush();
    fx.fabric.admit(alice, bob);
    await flush();
    expect(fx.connections.created.length).toBeGreaterThan(1);
    expect(sentKinds(fx.connections)).toEqual([]);

    // Unmuting is the LOCAL user's act, and only then does media flow.
    fx.session.setLocalTrackEnabled("audio", true);
    await flush();
    expect(sentKinds(fx.connections)).toContain("audio");
  });
});

const TRANSPORT_RESTART_MS = 20_000;

describe("replaceLocalTrack(kind, null)", () => {
  it("restores the MediaPort's track rather than removing the kind", async () => {
    const fx = await joined();
    fx.session.replaceLocalTrack("audio", new FakeTrack("mic-2", "audio"));
    await flush();
    const sentAudioIds = () =>
      fx.connections.created
        .flatMap((pc) => pc.getSenders())
        .filter((sender) => sender.track?.kind === "audio")
        .map((sender) => sender.track?.id);
    expect(sentAudioIds()).toContain("mic-2");

    // null is "forget my override", NOT "stop sending audio": the port's own
    // track comes back. Stopping a kind is setLocalTrackEnabled(kind, false).
    fx.session.replaceLocalTrack("audio", null);
    await flush();
    expect(sentAudioIds()).toContain("mic-1");
    expect(sentKinds(fx.connections)).toContain("audio");

    fx.session.setLocalTrackEnabled("audio", false);
    await flush();
    expect(sentKinds(fx.connections)).toEqual(["video"]);
  });
});

describe("a remote mute is visible", () => {
  it("drops the kind from the snapshot on mute and returns it on unmute", async () => {
    const fx = await joined();
    const pc = fx.connections.last;
    const remoteMic = new FakeTrack("bob-mic", "audio");
    pc.emitRemoteTrack(remoteMic);
    pc.emitRemoteTrack(new FakeTrack("bob-cam", "video"));

    const kinds = () =>
      fx.session.snapshot().peers.find((peer) => peer.peerId === "prs_bob dev_b")
        ?.remoteTrackKinds ?? [];
    expect(kinds()).toEqual(["audio", "video"]);

    // The real API keeps the transceiver and flips `muted`. A snapshot built
    // from `ontrack` alone would keep claiming bob is sending audio forever.
    remoteMic.setMuted(true);
    expect(kinds()).toEqual(["video"]);

    remoteMic.setMuted(false);
    expect(kinds()).toEqual(["audio", "video"]);
  });

  it("drops a kind whose track ended", async () => {
    const fx = await joined();
    const pc = fx.connections.last;
    const remoteCam = new FakeTrack("bob-cam", "video");
    pc.emitRemoteTrack(new FakeTrack("bob-mic", "audio"));
    pc.emitRemoteTrack(remoteCam);

    remoteCam.stop();
    expect(
      fx.session.snapshot().peers.find((peer) => peer.peerId === "prs_bob dev_b")
        ?.remoteTrackKinds,
    ).toEqual(["audio"]);
  });
});

describe("moderation control channel", () => {
  it("opens exactly one hq-meet-control channel on the polite side", async () => {
    const fx = await joined();
    const labels = fx.connections.last.channels.map((channel) => channel.label);
    expect(labels).toEqual([MODERATION_CHANNEL_LABEL]);
  });

  it("delivers a mute request to an admitted peer and refuses unknown peers", async () => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    expect(fx.session.sendModeration("prs_bob dev_b", "mute-force")).toBe(false);
    channel.open();
    expect(fx.session.sendModeration("prs_bob dev_b", "mute-force")).toBe(true);
    expect(channel.sent.map((raw) => parseModeration(raw))).toEqual([
      { kind: "moderation", action: "mute-force", track: "audio" },
    ]);
    expect(fx.session.sendModeration("prs_nobody dev_x", "mute-request")).toBe(
      false,
    );
  });

  it("surfaces an inbound mute-force but never mutes on its own", async () => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    const seen: string[] = [];
    fx.session.on("moderation", (event) => {
      seen.push(`${event.from.personUid}:${event.message.action}`);
    });
    channel.deliver(
      JSON.stringify({ kind: "moderation", action: "mute-force", track: "audio" }),
    );
    expect(seen).toEqual(["prs_bob:mute-force"]);
    // The ENGINE does not act: role authority is the host's roster question.
    expect(fx.session.snapshot().mutedKinds).toEqual([]);
  });

  it("ignores and counts every attempt to enable remote media", async () => {
    const fx = await joined();
    fx.session.setLocalTrackEnabled("audio", false);
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    const seen: string[] = [];
    fx.session.on("moderation", (event) => seen.push(event.message.action));
    for (const action of ["unmute", "unmute-force", "force-unmute", "enable"]) {
      channel.deliver(JSON.stringify({ kind: "moderation", action, track: "audio" }));
    }
    await flush();
    expect(seen).toEqual([]);
    expect(fx.session.snapshot().diagnostics.moderationUnmuteIgnored).toBe(4);
    expect(fx.session.snapshot().mutedKinds).toEqual(["audio"]);
    expect(sentKinds(fx.connections)).toEqual(["video"]);
  });

  it("drops control messages from an unadmitted peer", async () => {
    const fx = await joined();
    // Mallory is not on the roster, so no transport and no channel exist for
    // her at all - the admission gate is upstream of moderation.
    expect(fx.session.sendModeration("prs_mallory dev_m", "mute-force")).toBe(
      false,
    );
    expect(mallory.personUid).toBe("prs_mallory");
  });
});

describe("speaking heuristic", () => {
  it("latches on above the threshold and releases only after the hold", () => {
    const tracker = createSpeakingTracker({
      onThreshold: 0.2,
      offThreshold: 0.1,
      releaseMs: 500,
    });
    expect(tracker.observe("p1", 0.05, 0)).toBe(false);
    expect(tracker.observe("p1", 0.25, 100)).toBe(true);
    expect(tracker.isSpeaking("p1")).toBe(true);
    // A dip that does not last must not flicker the ring off.
    expect(tracker.observe("p1", 0.05, 200)).toBe(false);
    expect(tracker.observe("p1", 0.3, 300)).toBe(false);
    expect(tracker.isSpeaking("p1")).toBe(true);
    expect(tracker.observe("p1", 0.02, 400)).toBe(false);
    expect(tracker.observe("p1", 0.02, 1000)).toBe(true);
    expect(tracker.speaking()).toEqual([]);
  });

  it("forgets a peer outright", () => {
    const tracker = createSpeakingTracker();
    tracker.observe("p1", 1, 0);
    expect(tracker.speaking()).toEqual(["p1"]);
    tracker.forget("p1");
    expect(tracker.speaking()).toEqual([]);
  });
});
