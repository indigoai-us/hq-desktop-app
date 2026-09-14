/**
 * US-020 story acceptance tests (engine half) — "Build accessible small-room
 * audio and video controls".
 *
 * Story-level regression cover for two of the three PRD e2e statements, the
 * ones that are the ENGINE's to keep:
 *
 *   e2e 2 — a muted microphone and a camera that was turned off survive a
 *           device change and a reconnect: the prior privacy choice is still
 *           in force on the other side of renegotiation.
 *   e2e 3 — moderation is a message, never an authority: the engine surfaces
 *           an inbound control message and mutes NOBODY on its own, and no
 *           encoding exists that could enable a microphone.
 *
 * `media-mute.test.ts` pins those seams one at a time. This file pins the whole
 * sequence a person actually performs — mute, camera off, swap headset, lose
 * the connection, come back, unmute — and samples the invariant after EVERY
 * step, so a regression that re-attaches a muted track for a single
 * renegotiation window is caught rather than averaged away.
 *
 * Deterministic: a manual clock, a manual timer queue, scripted peer
 * connections, an in-memory signaling fabric. No network, no real timers.
 */

import { describe, expect, it } from "vitest";

import type { CallBinding, CallGrant, PeerIdentity } from "./ports.js";
import { createCallSession, type CallSession } from "./session.js";
import {
  MODERATION_ACTIONS,
  MODERATION_CHANNEL_LABEL,
  encodeModeration,
  isRemoteEnableAttempt,
  parseModeration,
} from "./moderation.js";
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
const ICE_RESTART_BACKOFF_MS = 1_000;
const TRANSPORT_RESTART_MS = 20_000;

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

/** Every kind any sender on any connection currently carries. */
function sentKinds(connections: FakeConnectionFactory): string[] {
  return connections.created
    .flatMap((pc) => pc.getSenders())
    .map((sender) => sender.track?.kind)
    .filter((kind): kind is string => typeof kind === "string")
    .sort();
}

/**
 * A running record of the invariant: one `sentKinds()` sample per step, so the
 * assertion is about the WHOLE sequence rather than its final frame.
 */
function recorder(connections: FakeConnectionFactory) {
  const samples: Array<{ step: string; kinds: string[] }> = [];
  return {
    sample(step: string): void {
      samples.push({ step, kinds: sentKinds(connections) });
    },
    /** Steps at which a muted kind was on the wire. Empty is the pass. */
    violations(kind: string): string[] {
      return samples
        .filter((entry) => entry.kinds.includes(kind))
        .map((entry) => entry.step);
    },
    get steps(): number {
      return samples.length;
    },
  };
}

// ── e2e 2 ────────────────────────────────────────────────────────────────────

describe("US-020 e2e 2: a privacy choice survives a device change and a reconnect", () => {
  it("never puts a muted kind on any sender, at any point in the sequence", async () => {
    const fx = await joined();
    const record = recorder(fx.connections);
    // Baseline: before the choice is made, both kinds are on the wire.
    expect(sentKinds(fx.connections)).toEqual(["audio", "video"]);

    // The person mutes the microphone and turns the camera off.
    fx.session.setLocalTrackEnabled("audio", false);
    fx.session.setLocalTrackEnabled("video", false);
    await flush();
    record.sample("muted");
    expect(fx.session.snapshot().mutedKinds.sort()).toEqual(["audio", "video"]);

    // They plug in a headset and pick a different camera. A device change is a
    // `replaceTrack`, which is exactly the path a naive implementation uses to
    // resurrect a muted track.
    fx.session.replaceLocalTrack("audio", new FakeTrack("mic-2", "audio"));
    await flush();
    record.sample("mic swapped");
    fx.session.replaceLocalTrack("video", new FakeTrack("cam-2", "video"));
    await flush();
    record.sample("camera swapped");

    // A fresh roster re-runs connect() on the live transport (renegotiation).
    fx.fabric.admit(alice, bob);
    await flush();
    record.sample("renegotiated");

    // The ICE path dies and the transport restarts it in place.
    fx.connections.last.setIceState("failed");
    fx.scheduler.advance(ICE_RESTART_BACKOFF_MS);
    await flush();
    record.sample("ice restarted");
    // The transport spent a restart from its budget: either `restartIce()` on
    // the live connection, or - when negotiation was still in flight - a fresh
    // one carrying the budget over. Both are re-attach paths.
    expect(fx.session.snapshot().peers[0]?.restartAttempts).toBeGreaterThan(0);

    // The connection fails outright and a brand-new one is built.
    const before = fx.connections.created.length;
    fx.connections.last.setConnectionState("failed");
    fx.scheduler.advance(TRANSPORT_RESTART_MS);
    await flush();
    fx.fabric.admit(alice, bob);
    await flush();
    record.sample("reconnected");
    expect(fx.connections.created.length).toBeGreaterThan(before);

    // A plain republish (the path every control takes) is sampled last.
    fx.session.refreshLocalTracks();
    await flush();
    record.sample("republished");

    // The whole point of the story: at no step, on no connection, did a sender
    // hold a track of a kind the person had muted.
    expect(record.steps).toBe(7);
    expect(record.violations("audio")).toEqual([]);
    expect(record.violations("video")).toEqual([]);
    expect(fx.session.snapshot().mutedKinds.sort()).toEqual(["audio", "video"]);
  });

  it("re-attaches only when the local person unmutes, after the reconnect", async () => {
    const fx = await joined();
    fx.session.setLocalTrackEnabled("audio", false);
    fx.session.setLocalTrackEnabled("video", false);
    await flush();

    fx.session.replaceLocalTrack("audio", new FakeTrack("mic-2", "audio"));
    fx.connections.last.setConnectionState("failed");
    fx.scheduler.advance(TRANSPORT_RESTART_MS);
    await flush();
    fx.fabric.admit(alice, bob);
    await flush();
    expect(sentKinds(fx.connections)).toEqual([]);

    // Unmuting is the LOCAL user's act; only then does media flow, and it is
    // the device they chose while muted that goes on the wire.
    fx.session.setLocalTrackEnabled("audio", true);
    await flush();
    expect(sentKinds(fx.connections)).toEqual(["audio"]);
    const audio = fx.connections.created
      .flatMap((pc) => pc.getSenders())
      .filter((sender) => sender.track?.kind === "audio")
      .map((sender) => sender.track?.id);
    expect(audio).toContain("mic-2");
    // The camera choice is untouched by the microphone: still off.
    expect(fx.session.snapshot().mutedKinds).toEqual(["video"]);
  });
});

// ── e2e 3 ────────────────────────────────────────────────────────────────────

describe("US-020 e2e 3: moderation is a message, never an authority", () => {
  it("round-trips exactly the two mute actions and nothing else", () => {
    for (const action of MODERATION_ACTIONS) {
      for (const track of ["audio", "video"] as const) {
        const message = { kind: "moderation" as const, action, track };
        expect(parseModeration(encodeModeration(message))).toEqual(message);
      }
    }
    // There is no unmute in the vocabulary, so there is no encoding of one.
    expect(MODERATION_ACTIONS).toEqual(["mute-request", "mute-force"]);
    expect(
      (MODERATION_ACTIONS as readonly string[]).some((action) =>
        /unmute|enable/i.test(action),
      ),
    ).toBe(false);
  });

  it("surfaces an inbound mute-force with its sender and mutes nothing itself", async () => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    expect(channel.label).toBe(MODERATION_CHANNEL_LABEL);

    const seen: Array<{ from: string; action: string }> = [];
    fx.session.on("moderation", (event) => {
      seen.push({
        from: `${event.from.personUid} ${event.from.deviceId}`,
        action: event.message.action,
      });
    });
    channel.deliver(
      encodeModeration({ kind: "moderation", action: "mute-force", track: "audio" }),
    );
    await flush();

    // The engine reports WHO sent it and stops there: whether that person may
    // moderate is a roster question the window answers, not the transport.
    expect(seen).toEqual([{ from: "prs_bob dev_b", action: "mute-force" }]);
    expect(fx.session.snapshot().mutedKinds).toEqual([]);
    expect(sentKinds(fx.connections)).toEqual(["audio", "video"]);
  });

  it("refuses every payload that is not one of the two mute actions", async () => {
    const fx = await joined();
    fx.session.setLocalTrackEnabled("audio", false);
    await flush();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;
    const seen: string[] = [];
    fx.session.on("moderation", (event) => seen.push(event.message.action));

    const enableAttempts = [
      "unmute",
      "unmute-force",
      "force-unmute",
      "enable",
      "start",
      "resume",
    ];
    for (const action of enableAttempts) {
      const payload = { kind: "moderation", action, track: "audio" };
      // Both halves of the refusal: unparseable, AND recognised as an attempt
      // to enable somebody else's media so it can be counted rather than lost.
      expect(parseModeration(JSON.stringify(payload))).toBeNull();
      expect(isRemoteEnableAttempt(payload)).toBe(true);
      channel.deliver(JSON.stringify(payload));
    }
    // Shapes that are merely wrong are dropped too, and counted as nothing.
    for (const payload of [
      { kind: "moderation", action: "mute-force", track: "screen" },
      { kind: "chat", action: "mute-force", track: "audio" },
      { action: "mute-force", track: "audio" },
      "not json",
      null,
    ]) {
      expect(
        parseModeration(typeof payload === "string" ? payload : JSON.stringify(payload)),
      ).toBeNull();
      channel.deliver(typeof payload === "string" ? payload : JSON.stringify(payload));
    }
    await flush();

    expect(seen).toEqual([]);
    expect(fx.session.snapshot().diagnostics.moderationUnmuteIgnored).toBe(
      enableAttempts.length,
    );
    // The mute the person chose is exactly where they left it.
    expect(fx.session.snapshot().mutedKinds).toEqual(["audio"]);
    expect(sentKinds(fx.connections)).toEqual(["video"]);
  });

  it("cannot deliver moderation without an open channel to an admitted peer", async () => {
    const fx = await joined();
    const channel = fx.connections.last.channels[0] as FakeDataChannel;

    // The channel exists but has not come up yet: nothing is sent, and the
    // caller is told so rather than believing a request landed.
    expect(fx.session.sendModeration("prs_bob dev_b", "mute-force")).toBe(false);
    expect(channel.sent).toEqual([]);

    channel.open();
    expect(fx.session.sendModeration("prs_bob dev_b", "mute-force")).toBe(true);
    expect(channel.sent.map((raw) => parseModeration(raw))).toEqual([
      { kind: "moderation", action: "mute-force", track: "audio" },
    ]);

    // A peer the roster never admitted has no transport and so no channel: the
    // admission gate is upstream of moderation.
    expect(fx.session.sendModeration("prs_nobody dev_x", "mute-request")).toBe(
      false,
    );
    expect(channel.sent).toHaveLength(1);
  });
});
