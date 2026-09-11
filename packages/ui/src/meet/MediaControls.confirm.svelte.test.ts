// @vitest-environment happy-dom

/**
 * The destructive-action confirm's keyboard and focus contract (US-020
 * follow-up).
 *
 * A confirm that opens without moving focus leaves a keyboard or screen-reader
 * user reading a dialog they cannot reach, and one that closes without putting
 * focus back drops them at the top of the document. Neither is visible in a
 * screenshot, so it is asserted here.
 *
 * Runes file (`.svelte.test.ts`) so props can be a `$state` proxy and a peer
 * can actually vanish from the roster while the confirm is open.
 */

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import MediaControls from "./MediaControls.svelte";
import { deriveCallView, type CallTile } from "./call-view-model.js";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function tilesFor(count: number): CallTile[] {
  return deriveCallView({
    snapshot: {
      self: { personUid: "prs_self", deviceId: "dev_self" },
      admitted: [
        { personUid: "prs_self", deviceId: "dev_self" },
        ...Array.from({ length: count }, (_, index) => ({
          personUid: `prs_p${index + 1}`,
          deviceId: `dev_p${index + 1}`,
        })),
      ],
      peers: [],
      rosterRevision: 1,
      trafficStopped: false,
    },
    self: { micMuted: false, cameraOff: false },
  }).tiles;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MediaControls, {
    target: host,
    props: props as never,
  });
  flushSync();
  return host;
}

function selectPeer(root: HTMLElement, id: string): void {
  const target = testid(root, "moderation-target") as HTMLSelectElement;
  target.value = id;
  target.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}

describe("the destructive confirm is reachable and escapable", () => {
  it("focuses Cancel on open and restores focus to the trigger on cancel", () => {
    const root = render({
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tilesFor(1),
      onendroom: () => {},
    });

    const trigger = testid(root, "moderation-end") as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    flushSync();

    // The SAFE choice takes focus, never the destructive one.
    expect(document.activeElement).toBe(
      testid(root, "moderation-confirm-cancel"),
    );

    (testid(root, "moderation-confirm-cancel") as HTMLButtonElement).click();
    flushSync();
    expect(testid(root, "moderation-confirm")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("cancels on Escape and puts focus back, without running the action", () => {
    const calls: string[] = [];
    const root = render({
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tilesFor(1),
      onendroom: () => calls.push("end"),
    });

    const trigger = testid(root, "moderation-end") as HTMLButtonElement;
    trigger.focus();
    trigger.click();
    flushSync();
    expect(testid(root, "moderation-confirm")).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    flushSync();

    expect(testid(root, "moderation-confirm")).toBeNull();
    expect(calls).toEqual([]);
    expect(document.activeElement).toBe(trigger);
  });

  it("says it is not modal, because nothing behind it is made inert", () => {
    const root = render({
      role: "host",
      micMuted: false,
      cameraOff: false,
      peers: tilesFor(1),
    });
    (testid(root, "moderation-end") as HTMLButtonElement).click();
    flushSync();

    const confirm = testid(root, "moderation-confirm");
    expect(confirm?.getAttribute("role")).toBe("alertdialog");
    expect(confirm?.getAttribute("aria-modal")).toBe("false");
    // The claim has to match reality: the bar behind it is still operable.
    expect(
      (testid(root, "control-leave") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("closes itself when the participant it is about leaves the roster", () => {
    const calls: string[] = [];
    const props = $state({
      role: "host" as const,
      micMuted: false,
      cameraOff: false,
      peers: tilesFor(2),
      onremovepeer: (tile: CallTile) => calls.push(`remove:${tile.id}`),
    });
    const root = render(props);

    selectPeer(root, "prs_p1 dev_p1");
    (testid(root, "moderation-remove") as HTMLButtonElement).click();
    flushSync();
    expect(testid(root, "moderation-confirm-text")?.textContent).toContain(
      "prs_p1",
    );

    // They leave (or another host removes them) while the confirm is open.
    // Accepting now would act on nobody, or on whoever the select slid to.
    props.peers = tilesFor(2).filter((tile) => tile.id !== "prs_p1 dev_p1");
    flushSync();

    expect(testid(root, "moderation-confirm")).toBeNull();
    expect(calls).toEqual([]);
  });
});
