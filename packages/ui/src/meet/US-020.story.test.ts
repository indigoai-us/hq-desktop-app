// @vitest-environment happy-dom

/**
 * US-020 story acceptance tests (surface half) — "Build accessible small-room
 * audio and video controls".
 *
 * Story-level regression cover for the PRD e2e statements that are the
 * SURFACE's to keep:
 *
 *   e2e 1 — eight connected participants, a roster that changes under them,
 *           and a layout plus controls that stay usable and never exceed the
 *           admission limit.
 *   e2e 3 — a host action runs only when the person is actually authorized to
 *           moderate, the destructive ones are confirmed, and no control at
 *           any authority level can enable somebody else's microphone.
 *
 * `CallView.test.ts` pins the layout model and the controls unit by unit. This
 * file pins what they add up to on screen: the cap holding while the roster
 * churns, every state reachable and readable from the keyboard, the speaking
 * ring staying a hedge rather than a claim, and moderation that a participant
 * simply does not have.
 *
 * Everything drives the public `meet` barrel. No network, no capture, no
 * `MediaStream` (the `attach` hook is never given one), no timers.
 */

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import { meet } from "../index.js";

const { CallView, MediaControls, CALL_TILE_LIMIT, canModerate, deriveCallView } =
  meet;

type CallPeerView = meet.CallPeerView;
type CallSnapshotView = meet.CallSnapshotView;

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

function teardown(): void {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
}

afterEach(teardown);

/**
 * Mount fresh and flush. Roster changes are driven by re-mounting with the
 * next authoritative snapshot: the layout is a pure function of that snapshot,
 * so a re-mount is the same input the running window folds in.
 */
function render(target: unknown, props: Record<string, unknown>): HTMLElement {
  teardown();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(target as never, { target: host, props: props as never });
  flushSync();
  return host;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function all(root: HTMLElement, id: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
}

function text(root: HTMLElement, id: string): string {
  return testid(root, id)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

const SELF = { personUid: "prs_self", deviceId: "dev_self" };
const SELF_MEDIA = { micMuted: false, cameraOff: false };

function peer(index: number, overrides: Partial<CallPeerView> = {}): CallPeerView {
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

/** A snapshot with `count` connected peers admitted alongside self. */
function snapshot(
  count: number,
  overrides: Partial<CallSnapshotView> = {},
): CallSnapshotView {
  const peers = Array.from({ length: count }, (_, index) => peer(index + 1));
  return {
    self: SELF,
    admitted: [
      SELF,
      ...peers.map(({ personUid, deviceId }) => ({ personUid, deviceId })),
    ],
    peers,
    rosterRevision: 3,
    trafficStopped: false,
    ...overrides,
  };
}

/** Join order for the first `count` peers, so ordering is deterministic. */
function joinOrder(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `prs_p${index + 1} dev_p${index + 1}`);
}

/** Every natively focusable control on the surface, in document order. */
function controls(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>("button, select, [href], input"),
  ];
}

const DEVICES = {
  list: async () => [
    { deviceId: "mic-a", label: "Built-in Microphone", kind: "audioinput" as const },
    { deviceId: "cam-a", label: "FaceTime HD Camera", kind: "videoinput" as const },
  ],
};

// ── e2e 1 ────────────────────────────────────────────────────────────────────

describe("US-020 e2e 1: eight people, a churning roster, and a cap that holds", () => {
  it("fills the gallery to exactly the admission limit with the controls intact", () => {
    // Seven peers plus self: the full small room.
    const root = render(CallView, {
      snapshot: snapshot(CALL_TILE_LIMIT - 1),
      self: SELF_MEDIA,
      joinOrder: joinOrder(CALL_TILE_LIMIT - 1),
    });

    const tiles = all(root, "call-tile");
    expect(tiles).toHaveLength(CALL_TILE_LIMIT);
    // Self first, then join order: the grid does not shuffle under the cursor.
    expect(tiles.map((tile) => tile.dataset.tileId)).toEqual([
      "self",
      ...joinOrder(CALL_TILE_LIMIT - 1),
    ]);

    const columns = Number(testid(root, "call-gallery")?.dataset.columns);
    expect(columns).toBeGreaterThanOrEqual(1);
    expect(columns).toBeLessThanOrEqual(4);
    // Nothing is hidden, so no overflow line is rendered at all.
    expect(testid(root, "call-overflow")).toBeNull();

    // The controls a person needs are all present at eight up.
    expect(testid(root, "media-controls")).not.toBeNull();
    expect(testid(root, "control-microphone")).not.toBeNull();
    expect(testid(root, "control-camera")).not.toBeNull();
    expect(testid(root, "control-leave")).not.toBeNull();
    // Every tile says its connection in TEXT, not by colour alone.
    expect(
      all(root, "call-tile-connection").every(
        (chip) => (chip.textContent ?? "").trim().length > 0,
      ),
    ).toBe(true);
  });

  it("refuses to render a ninth admitted participant, and never names them", () => {
    const base = snapshot(CALL_TILE_LIMIT - 1);
    const ninth = { personUid: "prs_late", deviceId: "dev_late" };
    const root = render(CallView, {
      snapshot: { ...base, admitted: [...base.admitted, ninth] },
      self: SELF_MEDIA,
      // The late arrival has no join-order entry, so it sorts last and is the
      // one that falls off the end.
      joinOrder: joinOrder(CALL_TILE_LIMIT - 1),
    });

    expect(all(root, "call-tile")).toHaveLength(CALL_TILE_LIMIT);
    // Content-free: a COUNT, never a name.
    expect(text(root, "call-overflow")).toContain("1 more");
    expect(root.innerHTML).not.toContain("prs_late");
    expect(root.innerHTML).not.toContain("dev_late");
  });

  it("shows a roster removal as removal, then lets the tile go", () => {
    const base = snapshot(3);
    // The roster stops admitting peer 2 while its transport still lingers.
    const removing = {
      ...base,
      admitted: base.admitted.filter((entry) => entry.personUid !== "prs_p2"),
    };
    let root = render(CallView, {
      snapshot: removing,
      self: SELF_MEDIA,
      joinOrder: joinOrder(3),
    });

    const removed = all(root, "call-tile").find(
      (tile) => tile.dataset.tileId === "prs_p2 dev_p2",
    );
    // Removal is a moderation OUTCOME, not a network problem: it reads
    // differently from "disconnected" and offers no retry.
    expect(removed?.dataset.connection).toBe("removed");
    expect(removed?.textContent).toContain("Removed from the call.");
    expect(all(root, "call-tile")).toHaveLength(4);

    // The engine closes the transport; the next snapshot simply has no tile.
    root = render(CallView, {
      snapshot: {
        ...removing,
        peers: base.peers.filter((entry) => entry.personUid !== "prs_p2"),
      },
      self: SELF_MEDIA,
      joinOrder: joinOrder(3),
    });
    expect(
      all(root, "call-tile").map((tile) => tile.dataset.tileId),
    ).not.toContain("prs_p2 dev_p2");
    expect(all(root, "call-tile")).toHaveLength(3);
  });

  it("stays fully keyboard operable with eight tiles and the device pickers up", async () => {
    const root = render(CallView, {
      snapshot: snapshot(CALL_TILE_LIMIT - 1),
      self: SELF_MEDIA,
      role: "participant",
      devices: DEVICES,
      joinOrder: joinOrder(CALL_TILE_LIMIT - 1),
    });
    // The pickers appear once the injected enumeration resolves.
    await Promise.resolve();
    await Promise.resolve();
    flushSync();

    const focusable = controls(root);
    expect(focusable.length).toBeGreaterThan(0);
    // Native buttons and selects only: nothing is reachable by mouse alone,
    // and nothing is pulled out of the tab order.
    for (const element of focusable) {
      expect(["BUTTON", "SELECT"]).toContain(element.tagName);
      expect(element.getAttribute("tabindex")).not.toBe("-1");
      expect((element as HTMLButtonElement).disabled).toBe(false);
      element.focus();
      expect(document.activeElement).toBe(element);
    }
    // Every control a person needs is in that traversal.
    for (const id of [
      "control-microphone",
      "device-microphone",
      "control-camera",
      "device-camera",
      "control-leave",
    ]) {
      expect(focusable).toContain(testid(root, id));
    }

    // Toggle state is exposed to assistive tech, not carried by colour.
    expect(
      testid(root, "control-microphone")?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(testid(root, "control-camera")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    // Roster and connection changes announce politely, never assertively.
    const announcement = testid(root, "call-announcement");
    expect(announcement?.getAttribute("aria-live")).toBe("polite");
    expect(announcement?.textContent).toContain("8 people in the call.");
  });

  it("says a peer may be speaking, and never claims that they did", () => {
    const root = render(CallView, {
      snapshot: snapshot(2),
      self: SELF_MEDIA,
      speaking: ["prs_p1 dev_p1"],
      joinOrder: joinOrder(2),
    });
    const chip = testid(root, "call-tile-speaking");
    // The heuristic is stated as a hedge in both the text and the label: it is
    // an audio-LEVEL guess, never diarization and never identity.
    expect(chip?.textContent?.trim()).toBe("May be speaking");
    expect(chip?.getAttribute("aria-label")).toContain("may be speaking");
    expect(root.innerHTML).not.toMatch(/\bis speaking\b/i);
    expect(root.innerHTML).not.toMatch(/\bsaid\b|\bspoke\b/i);
  });

  it("never flags a muted self tile as speaking, whatever the level says", () => {
    const root = render(CallView, {
      snapshot: snapshot(1),
      // A muted microphone sends nothing, so any level reading is stale.
      self: { micMuted: true, cameraOff: true, speaking: true },
      joinOrder: joinOrder(1),
    });
    const selfTile = all(root, "call-tile").find(
      (tile) => tile.dataset.tileId === "self",
    );
    expect(selfTile?.querySelector('[data-testid="call-tile-speaking"]')).toBeNull();
    expect(selfTile?.textContent).toContain("Muted");
    // A camera that is off says so instead of rendering a blank rectangle.
    expect(selfTile?.textContent).toContain("Camera off");
  });
});

// ── e2e 3 ────────────────────────────────────────────────────────────────────

describe("US-020 e2e 3: only an authorized host sees a moderation control", () => {
  const tiles = deriveCallView({ snapshot: snapshot(2), self: SELF_MEDIA }).tiles;

  it("gives a participant no moderation surface at all", () => {
    expect(canModerate("participant")).toBe(false);
    const root = render(CallView, {
      snapshot: snapshot(2),
      self: SELF_MEDIA,
      role: "participant",
      joinOrder: joinOrder(2),
    });
    expect(testid(root, "host-controls")).toBeNull();
    expect(testid(root, "moderation-mute-force")).toBeNull();
    expect(testid(root, "moderation-remove")).toBeNull();
    expect(testid(root, "moderation-end")).toBeNull();
    // Leaving is always theirs; it is not moderation.
    expect(testid(root, "control-leave")).not.toBeNull();
  });

  it("gives a host and a cohost the same moderation surface, with no unmute", () => {
    for (const role of ["host", "cohost"] as const) {
      expect(canModerate(role)).toBe(true);
      const root = render(MediaControls, {
        role,
        micMuted: false,
        cameraOff: false,
        peers: tiles,
      });
      expect(testid(root, "host-controls")).not.toBeNull();
      expect(testid(root, "moderation-mute-request")).not.toBeNull();
      expect(testid(root, "moderation-mute-force")).not.toBeNull();
      // Host mute can REQUEST or FORCE off; there is no control, at any
      // authority level, that turns somebody else's microphone on.
      expect(testid(root, "moderation-unmute")).toBeNull();
      expect(root.innerHTML.toLowerCase()).not.toContain("unmute them");
      expect(root.innerHTML.toLowerCase()).not.toMatch(/unmute (their|everyone)/);
    }
  });

  it("sends a mute as a request against a chosen target, and nothing else", () => {
    const sent: string[] = [];
    const root = render(MediaControls, {
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tiles,
      onmuterequest: (tile: { id: string }) => sent.push(`request:${tile.id}`),
      onmuteforce: (tile: { id: string }) => sent.push(`force:${tile.id}`),
    });

    // With nobody chosen, the per-person actions are inert rather than
    // ambiguous about who they would hit.
    expect(
      (testid(root, "moderation-mute-force") as HTMLButtonElement).disabled,
    ).toBe(true);

    const target = testid(root, "moderation-target") as HTMLSelectElement;
    target.value = "prs_p1 dev_p1";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    testid(root, "moderation-mute-request")?.click();
    testid(root, "moderation-mute-force")?.click();
    flushSync();
    expect(sent).toEqual(["request:prs_p1 dev_p1", "force:prs_p1 dev_p1"]);
  });

  it("confirms ending the room and removing someone, and cancels cleanly", () => {
    const done: string[] = [];
    const root = render(MediaControls, {
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tiles,
      onleave: () => done.push("leave"),
      onendroom: () => done.push("end"),
      onremovepeer: (tile: { id: string }) => done.push(`remove:${tile.id}`),
    });

    // Cancelling a room-end runs nothing and leaves the call alone.
    testid(root, "moderation-end")?.click();
    flushSync();
    expect(testid(root, "moderation-confirm")).not.toBeNull();
    expect(text(root, "moderation-confirm-text")).toContain("everyone");
    testid(root, "moderation-confirm-cancel")?.click();
    flushSync();
    expect(testid(root, "moderation-confirm")).toBeNull();
    expect(done).toEqual([]);

    // Removing is confirmed separately, names who it hits, and says plainly
    // that it is NOT a mute.
    const target = testid(root, "moderation-target") as HTMLSelectElement;
    target.value = "prs_p2 dev_p2";
    target.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    testid(root, "moderation-remove")?.click();
    flushSync();
    expect(text(root, "moderation-confirm-text")).toContain("not muted");
    testid(root, "moderation-confirm-cancel")?.click();
    flushSync();
    expect(done).toEqual([]);

    // Accepted, the three outcomes stay distinct: leave is mine alone, end is
    // everyone's, remove is one named person's.
    testid(root, "control-leave")?.click();
    flushSync();
    testid(root, "moderation-remove")?.click();
    flushSync();
    testid(root, "moderation-confirm-accept")?.click();
    flushSync();
    testid(root, "moderation-end")?.click();
    flushSync();
    testid(root, "moderation-confirm-accept")?.click();
    flushSync();
    expect(done).toEqual(["leave", "remove:prs_p2 dev_p2", "end"]);
  });
});
