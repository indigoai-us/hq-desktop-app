/**
 * US-020 story acceptance tests (window half) — "Build accessible small-room
 * audio and video controls".
 *
 * Story-level regression cover for the PRD e2e statements where the CALL
 * WINDOW is the one that has to be right: who may moderate, what an inbound
 * moderation message is allowed to do to this device, how leave / host-end /
 * host-mute / remove stay four distinct things, and that picking an input
 * device is never a capture.
 *
 * Everything drives the public seam — `startCallWindow` with injected
 * `invoke`/`listen`/`whoami`/`getUserMedia`/`connections`, over the US-017
 * bench shape (the same per-path `hq_pro_fetch` router, so the real signaling
 * port polls a real reconcile and the real snapshots are folded). No Tauri, no
 * webview, no WebRTC, no network, and no capture that a test did not ask for.
 *
 * `src/call/us020.test.ts` pins the pure policy (`moderationOutcome`,
 * `canModerateRole`) and the media controller; this file pins the behaviour
 * they are supposed to add up to in a live window.
 */

import { describe, expect, it, vi } from "vitest";
import { encodeModeration, parseModeration } from "@hq/meet-core";
import { FakeConnectionFactory, FakeDataChannel } from "@hq/meet-core/testing";

import {
  startCallWindow,
  type CallInvoke,
  type CallWindowDeps,
  type CallWindowHandle,
} from "../../src/call/bootstrap";
import { MEDIA_DEVICE_KEY } from "../../src/call/permissions";
import type { CallWindowTarget } from "../../src/call/target";

const SESSION_ID = "cmp-indigo:room-1:call-1:7";
const ROOM_ID = "room-1";
const COMPANY = "cmp-indigo";

const ADMIT_PATH = "/v1/meet-native/signaling/admit";
const RECONCILE_PATH = "/v1/meet-native/signaling/reconcile";
const REVOKE_PATH = "/v1/meet-native/signaling/revoke";
const ROOM_PATH = `/v1/meet-native/rooms/${ROOM_ID}`;
const END_PATH = `/v1/meet-native/rooms/${ROOM_ID}/end`;

/** The remembered-device key is the one the shared UI model names. */
const DEVICE_PREFS_KEY = "meet.media.devices";

const SELF = { personUid: "prs_1", deviceId: "dev-1" };
const PEER = { personUid: "prs_2", deviceId: "dev-2", peerKey: "c".repeat(64) };
const PEER_ID = `${PEER.personUid} ${PEER.deviceId}`;

function target(): CallWindowTarget {
  return {
    sessionId: SESSION_ID,
    companyUid: COMPANY,
    roomId: ROOM_ID,
    callId: "call-1",
    epoch: 7,
    self: SELF,
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

interface Bench {
  deps: CallWindowDeps;
  connections: FakeConnectionFactory;
  /** Bodies posted per hq-pro path, newest last. */
  posted: Map<string, Array<Record<string, unknown>>>;
  urls: string[];
  commands: () => string[];
  argsOf: (command: string) => Record<string, unknown> | undefined;
  getUserMedia: ReturnType<typeof vi.fn>;
  storage: { data: Map<string, string> };
}

/**
 * The window bench: every native and platform seam injected, and one hq-pro
 * router that answers admit, reconcile, the room record and the two host
 * routes. Nothing here reaches a network.
 */
function bench(
  options: {
    /** This device's role, as the backend GRANT states it. Never asserted. */
    role?: "host" | "cohost" | "participant";
    /** The room record's owner. Decides whose moderation we honour. */
    host?: string | null;
    cohosts?: string[];
    /** Refuse the room-end route. */
    endFails?: boolean;
    /** Refuse the revoke control route. */
    revokeFails?: boolean;
  } = {},
): Bench {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const posted = new Map<string, Array<Record<string, unknown>>>();
  const urls: string[] = [];
  const storageData = new Map<string, string>();
  const connections = new FakeConnectionFactory();

  const record = (path: string, body: Record<string, unknown>): void => {
    posted.set(path, [...(posted.get(path) ?? []), body]);
  };

  const invoke: CallInvoke = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    if (command === "calls_take_pending_target") return target();
    if (command === "get_auth_session") {
      return { accountId: "acct-1", generation: 1, status: "active", reason: null };
    }
    if (command !== "hq_pro_fetch") return null;

    const request = (args ?? {}) as { url?: unknown; body?: unknown };
    const url = String(request.url ?? "");
    urls.push(url);
    const body =
      typeof request.body === "string" && request.body.length > 0
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : {};

    if (url === ADMIT_PATH) {
      record(ADMIT_PATH, body);
      return {
        status: 200,
        body: JSON.stringify({
          code: "OK",
          grant: {
            grantId: "grant-1",
            role: options.role ?? "participant",
            rosterRevision: 0,
            expiresAt: Date.now() + 600_000,
          },
          renewAfterMs: 60_000,
          trafficStopMs: 30_000,
          controlPollMs: 5,
        }),
      };
    }
    if (url === RECONCILE_PATH) {
      return {
        status: 200,
        body: JSON.stringify({
          code: "OK",
          rosterRevision: 2,
          peers: [{ ...SELF, peerKey: "d".repeat(64) }, PEER],
          expiresAt: Date.now() + 600_000,
        }),
      };
    }
    if (url === END_PATH) {
      record(END_PATH, body);
      return options.endFails
        ? { status: 503, body: "{}" }
        : { status: 200, body: JSON.stringify({ code: "OK" }) };
    }
    if (url === REVOKE_PATH) {
      record(REVOKE_PATH, body);
      return options.revokeFails
        ? { status: 503, body: "{}" }
        : { status: 200, body: JSON.stringify({ code: "OK" }) };
    }
    if (url.startsWith(ROOM_PATH)) {
      return {
        status: 200,
        body: JSON.stringify({
          code: "OK",
          room: {
            roomId: ROOM_ID,
            companyUid: COMPANY,
            host: options.host === undefined ? SELF.personUid : options.host,
            cohosts: options.cohosts ?? [],
          },
        }),
      };
    }
    // Signals and everything else succeed quietly: this story is about the
    // control plane, not about media negotiation.
    return { status: 200, body: JSON.stringify({ code: "OK" }) };
  };

  const getUserMedia = vi.fn(async (constraints: unknown) => {
    const kind =
      constraints && typeof constraints === "object" && "video" in constraints
        ? "video"
        : "audio";
    return {
      getTracks: () => [{ id: `${kind}-1`, kind, stop: () => {} }],
    };
  });

  const deps: CallWindowDeps = {
    invoke,
    listen: async () => () => {},
    targetWaitMs: 20,
    createSigner: async () => ({
      peerKey: "d".repeat(64),
      publicKey: "e".repeat(43),
      sign: async () => "f".repeat(86),
    }),
    connections,
    identity: {
      whoami: (async () => ({
        ok: true as const,
        value: { personUid: SELF.personUid, email: "a@b.c" },
      })) as never,
    },
    getUserMedia: getUserMedia as never,
    storage: {
      getItem: (key: string) => storageData.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageData.set(key, value);
      },
    },
  };

  return {
    deps,
    connections,
    posted,
    urls,
    commands: () => calls.map((entry) => entry.command),
    argsOf: (command) => calls.find((entry) => entry.command === command)?.args,
    getUserMedia,
    storage: { data: storageData },
  };
}

/** Start a window and wait until it holds a transport to the admitted peer. */
async function connected(harness: Bench): Promise<CallWindowHandle> {
  const handle = await startCallWindow(harness.deps);
  await until(
    () => harness.connections.created.length > 0,
    "a transport to the admitted peer",
  );
  await settle();
  return handle;
}

/** The `hq-meet-control` channel this window opened toward the peer. */
function controlChannel(harness: Bench): FakeDataChannel {
  const channel = harness.connections.created[0]?.channels[0];
  if (!channel) throw new Error("no control channel was opened");
  return channel;
}

// ── e2e 3: authority ─────────────────────────────────────────────────────────

describe("US-020 e2e 3: host authority is read from the room, never asserted", () => {
  it("resolves the room's host and this device's granted role after the join", async () => {
    const harness = bench({ role: "host", host: SELF.personUid, cohosts: ["prs_3"] });
    const handle = await connected(harness);

    await until(
      () => handle.state().hostPersonUid !== null,
      "the room record to answer",
    );
    expect(handle.state().role).toBe("host");
    expect(handle.state().hostPersonUid).toBe(SELF.personUid);
    expect(handle.state().cohosts).toEqual(["prs_3"]);
    // The room is read AFTER the join, so it never sits in front of the
    // control plane; until it answers, nobody is a host here.
    expect(harness.urls.indexOf(ADMIT_PATH)).toBeLessThan(
      harness.urls.findIndex((url) => url.startsWith(ROOM_PATH)),
    );
    await handle.close();
  });

  it("sends a host mute over the control channel, and refuses a participant's", async () => {
    const asHost = bench({ role: "host" });
    const hostHandle = await connected(asHost);
    const channel = controlChannel(asHost);
    channel.open();

    expect(hostHandle.moderateMute(PEER_ID, true)).toBe(true);
    expect(channel.sent.map((raw) => parseModeration(raw))).toEqual([
      { kind: "moderation", action: "mute-force", track: "audio" },
    ]);
    // A request and a force are distinct messages; neither can enable audio.
    expect(hostHandle.moderateMute(PEER_ID, false)).toBe(true);
    expect(parseModeration(channel.sent[1] ?? "")).toEqual({
      kind: "moderation",
      action: "mute-request",
      track: "audio",
    });
    expect(channel.sent.join(" ")).not.toMatch(/unmute|enable/i);
    await hostHandle.close();

    // The same call from a window the backend granted no authority sends
    // NOTHING: hiding the control is a courtesy, this is the check.
    const asParticipant = bench({ role: "participant" });
    const handle = await connected(asParticipant);
    const quiet = controlChannel(asParticipant);
    quiet.open();
    expect(handle.moderateMute(PEER_ID, true)).toBe(false);
    expect(quiet.sent).toEqual([]);
    await handle.close();
  });

  it("honours an inbound mute-force from the room's host, and lets the person unmute", async () => {
    // The room says prs_2 owns it, so their client's mute-force is honoured.
    const harness = bench({ role: "participant", host: PEER.personUid });
    const handle = await connected(harness);
    await until(() => handle.state().hostPersonUid === PEER.personUid, "the room record");

    await handle.setDevice("microphone", true);
    expect(handle.state().media.microphone.active).toBe(true);

    controlChannel(harness).deliver(
      encodeModeration({ kind: "moderation", action: "mute-force", track: "audio" }),
    );
    await settle();

    // Muted locally, and told why in words a person can act on.
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.state().notice).toContain("muted your microphone");
    expect(handle.session?.mutedKinds()).toContain("audio");

    // The control to come back is still theirs: a host mute is never a lock.
    await handle.setDevice("microphone", true);
    expect(handle.state().media.microphone.active).toBe(true);
    expect(handle.session?.mutedKinds()).not.toContain("audio");
    handle.dismissNotice();
    expect(handle.state().notice).toBeNull();
    await handle.close();
  });

  it("ignores a mute-force from a peer the room does not make a host", async () => {
    // prs_1 (this window) owns the room, so prs_2 is just a participant.
    const harness = bench({ role: "host", host: SELF.personUid });
    const handle = await connected(harness);
    await until(() => handle.state().hostPersonUid === SELF.personUid, "the room record");

    await handle.setDevice("microphone", true);
    controlChannel(harness).deliver(
      encodeModeration({ kind: "moderation", action: "mute-force", track: "audio" }),
    );
    await settle();

    expect(handle.state().media.microphone.active).toBe(true);
    expect(handle.state().notice).toBeNull();

    // And no encoding of "unmute" reaches the window at all: it is refused
    // upstream and counted, so a muted microphone stays muted.
    handle.media?.disableMicrophone();
    handle.session?.setLocalTrackEnabled("audio", false);
    controlChannel(harness).deliver(
      JSON.stringify({ kind: "moderation", action: "unmute", track: "audio" }),
    );
    await settle();
    expect(handle.session?.mutedKinds()).toContain("audio");
    expect(
      handle.session?.snapshot().diagnostics.moderationUnmuteIgnored,
    ).toBe(1);
    await handle.close();
  });

  it("removes a participant with a signed revoke naming only them", async () => {
    const harness = bench({ role: "host" });
    const handle = await connected(harness);

    expect(await handle.removePeer(PEER.personUid)).toBe(true);
    const body = harness.posted.get(REVOKE_PATH)?.[0] as Record<string, unknown>;
    expect(body).toBeDefined();
    expect(body).toMatchObject({
      kind: "control",
      operation: "revoke",
      companyUid: COMPANY,
      roomId: ROOM_ID,
      callId: "call-1",
      epoch: 7,
      personUid: SELF.personUid,
      deviceId: SELF.deviceId,
      targetPersonUid: PEER.personUid,
      grantId: "grant-1",
    });
    expect(typeof body.signature).toBe("string");
    // Content-free: ids and the device's PUBLIC key id, nothing else. No
    // tokens, no private key material, no media, no person content.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/bearer|authorization|privateKey|secret/i);
    expect(serialized).not.toMatch(/sdp|candidate/i);
    // Removal is not a mute: nothing went out on the control channel.
    expect(controlChannel(harness).sent).toEqual([]);
    await handle.close();
  });

  it("refuses removal and room-end outright from a window with no authority", async () => {
    const harness = bench({ role: "participant" });
    const handle = await connected(harness);

    expect(await handle.removePeer(PEER.personUid)).toBe(false);
    expect(await handle.endRoom()).toBe(false);
    expect(harness.posted.get(REVOKE_PATH)).toBeUndefined();
    expect(harness.posted.get(END_PATH)).toBeUndefined();
    expect(harness.commands()).not.toContain("calls_release");
    await handle.close();
  });

  it("ends the room for everyone and still gives up its own lease", async () => {
    const harness = bench({ role: "host" });
    const handle = await connected(harness);

    expect(await handle.endRoom()).toBe(true);
    expect(harness.posted.get(END_PATH)).toHaveLength(1);
    // Ending the room is not leaving it - both have to happen.
    expect(handle.state().status).toBe("left");
    expect(harness.argsOf("calls_release")).toMatchObject({
      sessionId: SESSION_ID,
    });
    await handle.close();
  });

  it("failure path: a refused room-end says so and leaves the call running", async () => {
    const harness = bench({ role: "host", endFails: true });
    const handle = await connected(harness);

    expect(await handle.endRoom()).toBe(false);
    expect(handle.state().notice).toContain("could not be ended");
    expect(handle.state().status).not.toBe("left");
    await handle.close();
  });
});

// ── e2e 2: device choice is not capture ──────────────────────────────────────

describe("US-020 e2e 2: picking a device is a choice, never a capture", () => {
  it("remembers the choice without opening the device while muted", async () => {
    const harness = bench({ role: "participant" });
    const handle = await connected(harness);
    expect(handle.state().media.microphone.active).toBe(false);

    await handle.selectDevice("microphone", "mic-b");
    await handle.selectDevice("camera", "cam-b");

    // The whole point: nothing was opened, so no OS indicator lit.
    expect(harness.getUserMedia).not.toHaveBeenCalled();
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.state().devices).toMatchObject({
      microphoneId: "mic-b",
      cameraId: "cam-b",
    });
    await handle.close();
  });

  it("stores device ids only - never a device label", async () => {
    const harness = bench({ role: "participant" });
    const handle = await connected(harness);
    await handle.selectDevice("microphone", "mic-b");

    // The remembered-choice key is the one the shared UI model names, so the
    // window and the pickers read the same store.
    expect(MEDIA_DEVICE_KEY).toBe(DEVICE_PREFS_KEY);
    const raw = harness.storage.data.get(MEDIA_DEVICE_KEY) ?? "";
    const stored = JSON.parse(raw) as Record<string, unknown>;
    expect(stored).toMatchObject({ microphoneId: "mic-b" });
    // Device LABELS identify hardware, and through it people. Ids only.
    expect(Object.keys(stored).sort()).toEqual(["cameraId", "microphoneId"]);
    expect(raw.toLowerCase()).not.toContain("label");
    expect(raw.toLowerCase()).not.toContain("built-in");
    await handle.close();
  });

  it("keeps a host mute in force across a device change", async () => {
    const harness = bench({ role: "participant", host: PEER.personUid });
    const handle = await connected(harness);
    await until(() => handle.state().hostPersonUid === PEER.personUid, "the room record");
    await handle.setDevice("microphone", true);

    controlChannel(harness).deliver(
      encodeModeration({ kind: "moderation", action: "mute-force", track: "audio" }),
    );
    await settle();
    expect(handle.session?.mutedKinds()).toContain("audio");
    const opens = harness.getUserMedia.mock.calls.length;

    // Swapping the microphone while muted changes the CHOICE, not the state:
    // the device stays shut and the mute is still in force.
    await handle.selectDevice("microphone", "mic-c");
    await settle();
    expect(harness.getUserMedia.mock.calls.length).toBe(opens);
    expect(handle.state().media.microphone.active).toBe(false);
    expect(handle.session?.mutedKinds()).toContain("audio");
    expect(handle.state().devices.microphoneId).toBe("mic-c");
    await handle.close();
  });
});
