// @vitest-environment happy-dom

/**
 * US-020 call view: 1..8 tiles that never exceed the admission limit, every
 * state carried by text as well as shape, a heuristic speaking label that says
 * so, and moderation that is host-only, confirmed, and has no path to enabling
 * somebody else's microphone.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import CallView from "./CallView.svelte";
import MediaControls from "./MediaControls.svelte";
import {
  CALL_TILE_LIMIT,
  canModerate,
  deriveCallView,
  parseDevicePreferences,
  resolveDevice,
  tileColumns,
  type CallPeerView,
  type CallSnapshotView,
} from "./call-view-model.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(
  target: unknown,
  props: Record<string, unknown>,
): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(target as typeof CallView, {
    target: host,
    props: props as never,
  });
  flushSync();
  return host;
}

function all(root: HTMLElement, id: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

const SELF = { personUid: "prs_self", deviceId: "dev_self" };

function peer(
  index: number,
  overrides: Partial<CallPeerView> = {},
): CallPeerView {
  return {
    peerId: `prs_p${index} dev_p${index}`,
    personUid: `prs_p${index}`,
    deviceId: `dev_p${index}`,
    status: "connected",
    connectionState: "connected",
    restartAttempts: 0,
    remoteTrackKinds: ["audio", "video"],
    ...overrides,
  };
}

function snapshot(count: number, overrides: Partial<CallSnapshotView> = {}) {
  const peers = Array.from({ length: count }, (_, index) => peer(index + 1));
  return {
    self: SELF,
    admitted: [
      SELF,
      ...peers.map(({ personUid, deviceId }) => ({ personUid, deviceId })),
    ],
    peers,
    rosterRevision: 2,
    trafficStopped: false,
    ...overrides,
  } satisfies CallSnapshotView;
}

const SELF_MEDIA = { micMuted: false, cameraOff: false };

describe("call layout", () => {
  it("adapts from one to eight tiles", () => {
    for (let peers = 0; peers < CALL_TILE_LIMIT; peers += 1) {
      const layout = deriveCallView({
        snapshot: snapshot(peers),
        self: SELF_MEDIA,
      });
      expect(layout.tiles).toHaveLength(peers + 1);
      expect(layout.tiles[0]?.self).toBe(true);
      expect(layout.overflow).toBe(0);
    }
    expect(tileColumns(1)).toBe(1);
    expect(tileColumns(4)).toBe(2);
    expect(tileColumns(8)).toBe(3);
  });

  it("never renders a ninth admitted participant as a tile", () => {
    // A roster that somehow carries more than the admission limit is a
    // contract violation upstream; the layout still refuses to render it, and
    // says only HOW MANY are hidden - never who.
    const base = snapshot(8);
    const ninth = { personUid: "prs_p9", deviceId: "dev_p9" };
    const layout = deriveCallView({
      snapshot: { ...base, admitted: [...base.admitted, ninth] },
      self: SELF_MEDIA,
    });
    expect(layout.tiles).toHaveLength(CALL_TILE_LIMIT);
    expect(layout.overflow).toBe(2);
    expect(JSON.stringify(layout)).not.toContain("prs_p9");
    expect(layout.atLimit).toBe(true);
  });

  it("orders self first, then by join order, then lexically", () => {
    const layout = deriveCallView({
      snapshot: snapshot(3),
      self: SELF_MEDIA,
      joinOrder: ["prs_p3 dev_p3", "prs_p1 dev_p1"],
    });
    expect(layout.tiles.map((tile) => tile.id)).toEqual([
      "self",
      "prs_p3 dev_p3",
      "prs_p1 dev_p1",
      "prs_p2 dev_p2",
    ]);
  });

  it("maps engine diagnostics to per-tile recovery states", () => {
    const base = snapshot(3);
    const peers = [
      peer(1, { status: "reconnecting", restartAttempts: 2 }),
      peer(2, { status: "failed", restartAttempts: 5 }),
      peer(3, { status: "connecting", remoteTrackKinds: [] }),
    ];
    const layout = deriveCallView({
      snapshot: { ...base, peers },
      self: SELF_MEDIA,
    });
    expect(layout.tiles.map((tile) => tile.connection)).toEqual([
      "connected",
      "reconnecting",
      "disconnected",
      "connecting",
    ]);
    expect(layout.tiles[1]?.recovery).toMatch(/Reconnecting/);
    expect(layout.tiles[2]?.recovery).toMatch(/leave and rejoin/);
    // No remote audio/video track means nothing is arriving, so the tile says
    // muted/camera off rather than guessing at the remote UI's intent.
    expect(layout.tiles[3]?.micMuted).toBe(true);
    expect(layout.tiles[3]?.cameraOff).toBe(true);
  });

  it("shows a removed peer distinctly from a disconnected one", () => {
    const base = snapshot(2);
    const layout = deriveCallView({
      // Peer 2 left the authoritative roster but the transport lingers.
      snapshot: { ...base, admitted: [SELF, base.admitted[1]!] },
      self: SELF_MEDIA,
    });
    const removed = layout.tiles.find((tile) => tile.connection === "removed");
    expect(removed?.personUid).toBe("prs_p2");
    expect(removed?.recovery).toBe("Removed from the call.");
  });

  it("never flags a muted self tile as speaking", () => {
    const layout = deriveCallView({
      snapshot: snapshot(1),
      self: { micMuted: true, cameraOff: false, speaking: true },
    });
    expect(layout.tiles[0]?.maybeSpeaking).toBe(false);
    expect(layout.tiles[0]?.micMuted).toBe(true);
  });

  it("shows a traffic stop on every tile", () => {
    const layout = deriveCallView({
      snapshot: snapshot(2, { trafficStopped: true }),
      self: SELF_MEDIA,
    });
    expect(
      layout.tiles.every((tile) => tile.connection === "disconnected"),
    ).toBe(true);
  });
});

describe("call view rendering", () => {
  it("renders eight tiles with text labels for every state", () => {
    const root = render(CallView, {
      snapshot: snapshot(7),
      self: SELF_MEDIA,
      speaking: ["prs_p1 dev_p1"],
    });
    expect(all(root, "call-tile")).toHaveLength(8);
    expect(testid(root, "call-gallery")?.dataset.columns).toBe("3");
    // The speaking ring is decoration; the CHIP is the accessible carrier.
    const speaking = testid(root, "call-tile-speaking");
    expect(speaking?.textContent?.trim()).toBe("May be speaking");
    expect(speaking?.getAttribute("aria-label")).toContain("may be speaking");
    expect(
      all(root, "call-tile-connection").map((el) => el.textContent?.trim()),
    ).toContain("Connected");
    expect(testid(root, "call-announcement")?.getAttribute("aria-live")).toBe(
      "polite",
    );
  });

  it("shows a content-free overflow count and no hidden names", () => {
    const base = snapshot(8);
    const root = render(CallView, {
      snapshot: {
        ...base,
        admitted: [
          ...base.admitted,
          { personUid: "prs_hidden", deviceId: "dev_hidden" },
        ],
      },
      self: SELF_MEDIA,
      // Join order is authoritative for ordering, so the late arrival is the
      // one that falls off the end.
      joinOrder: base.peers.map((entry) => entry.peerId),
    });
    expect(all(root, "call-tile")).toHaveLength(8);
    expect(testid(root, "call-overflow")?.textContent).toContain("2 more");
    expect(root.innerHTML).not.toContain("prs_hidden");
    expect(root.innerHTML).not.toContain("prs_p8");
  });

  it("says the camera is off instead of rendering a blank tile", () => {
    const root = render(CallView, {
      snapshot: snapshot(0),
      self: { micMuted: true, cameraOff: true },
    });
    expect(testid(root, "call-tile-placeholder")?.textContent?.trim()).toBe(
      "Camera off",
    );
    expect(testid(root, "call-tile-muted")?.textContent?.trim()).toBe("Muted");
  });
});

describe("media controls", () => {
  const DEVICES = {
    list: async () => [
      { deviceId: "mic-a", label: "Built-in", kind: "audioinput" as const },
      { deviceId: "mic-b", label: "Headset", kind: "audioinput" as const },
      { deviceId: "cam-a", label: "FaceTime", kind: "videoinput" as const },
    ],
  };

  it("toggles report state through aria-pressed, not colour", async () => {
    const toggled: boolean[] = [];
    const root = render(MediaControls, {
      role: "participant",
      micMuted: true,
      cameraOff: false,
      ontogglemicrophone: (next: boolean) => toggled.push(next),
    });
    const mic = testid(root, "control-microphone");
    expect(mic?.getAttribute("aria-pressed")).toBe("false");
    expect(mic?.textContent?.trim()).toBe("Unmute");
    expect(testid(root, "control-camera")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    mic?.click();
    flushSync();
    expect(toggled).toEqual([true]);
  });

  it("lists devices from the injected port and remembers the choice", async () => {
    const chosen: Array<[string, string]> = [];
    const root = render(MediaControls, {
      role: "participant",
      micMuted: false,
      cameraOff: false,
      devices: DEVICES,
      selectedMicrophoneId: "mic-b",
      onselectdevice: (kind: string, id: string) => chosen.push([kind, id]),
    });
    await vi.waitFor(() => {
      expect(testid(root, "device-microphone")).not.toBeNull();
    });
    flushSync();
    const select = testid(root, "device-microphone") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      "mic-a",
      "mic-b",
    ]);
    expect(select.value).toBe("mic-b");
    select.value = "mic-a";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(chosen).toEqual([["microphone", "mic-a"]]);
  });

  it("hides moderation from a participant and shows it to a host", () => {
    const asParticipant = render(MediaControls, {
      role: "participant",
      micMuted: false,
      cameraOff: false,
    });
    expect(testid(asParticipant, "host-controls")).toBeNull();
    unmount(component!);
    component = null;
    host?.remove();

    const asHost = render(MediaControls, {
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: deriveCallView({ snapshot: snapshot(1), self: SELF_MEDIA }).tiles,
    });
    expect(testid(asHost, "host-controls")).not.toBeNull();
    expect(testid(asHost, "moderation-mute-force")).not.toBeNull();
    // There is no unmute control at ANY authority level.
    expect(asHost.innerHTML.toLowerCase()).not.toContain("unmute them");
    expect(testid(asHost, "moderation-unmute")).toBeNull();
  });

  it("keeps leave, end room and remove as three distinct actions", () => {
    const calls: string[] = [];
    const tiles = deriveCallView({
      snapshot: snapshot(1),
      self: SELF_MEDIA,
    }).tiles;
    const root = render(MediaControls, {
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tiles,
      onleave: () => calls.push("leave"),
      onendroom: () => calls.push("end"),
      onremovepeer: (tile: { id: string }) => calls.push(`remove:${tile.id}`),
      onmuteforce: (tile: { id: string }) => calls.push(`force:${tile.id}`),
    });

    // Leaving is mine alone and needs no confirm.
    testid(root, "control-leave")?.click();
    flushSync();
    expect(calls).toEqual(["leave"]);

    // Ending the room affects everyone, so it is confirmed and says so.
    testid(root, "moderation-end")?.click();
    flushSync();
    expect(testid(root, "moderation-confirm-text")?.textContent).toContain(
      "everyone",
    );
    testid(root, "moderation-confirm-accept")?.click();
    flushSync();
    expect(calls).toEqual(["leave", "end"]);

    // Removing needs a selected target, and is confirmed separately.
    const target = testid(root, "moderation-target") as HTMLSelectElement;
    target.value = "prs_p1 dev_p1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    testid(root, "moderation-mute-force")?.click();
    flushSync();
    expect(calls).toContain("force:prs_p1 dev_p1");
    testid(root, "moderation-remove")?.click();
    flushSync();
    expect(testid(root, "moderation-confirm-text")?.textContent).toContain(
      "not muted",
    );
    testid(root, "moderation-confirm-accept")?.click();
    flushSync();
    expect(calls).toContain("remove:prs_p1 dev_p1");
  });

  it("cancels a destructive action without running it", () => {
    const calls: string[] = [];
    const root = render(MediaControls, {
      role: "cohost",
      micMuted: false,
      cameraOff: false,
      onendroom: () => calls.push("end"),
    });
    testid(root, "moderation-end")?.click();
    flushSync();
    testid(root, "moderation-confirm-cancel")?.click();
    flushSync();
    expect(testid(root, "moderation-confirm")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("helpers", () => {
  it("gates moderation on role", () => {
    expect(canModerate("host")).toBe(true);
    expect(canModerate("cohost")).toBe(true);
    expect(canModerate("participant")).toBe(false);
  });

  it("falls back when a remembered device disappeared", () => {
    const options = [
      { deviceId: "mic-a", label: "A", kind: "audioinput" as const },
    ];
    expect(resolveDevice("mic-gone", options)).toBe("mic-a");
    expect(resolveDevice("mic-a", options)).toBe("mic-a");
    expect(resolveDevice("mic-a", [])).toBeNull();
  });

  it("reads remembered device ids defensively", () => {
    expect(parseDevicePreferences("not json")).toEqual({
      microphoneId: null,
      cameraId: null,
    });
    expect(parseDevicePreferences('{"microphoneId":"mic-a"}')).toEqual({
      microphoneId: "mic-a",
      cameraId: null,
    });
  });
});
