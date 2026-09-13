// @vitest-environment happy-dom

/**
 * The permission card's job is to offer the ONE action that can actually
 * change the user's situation.
 *
 * The trap it replaces: macOS has no `+` button in the Camera or Microphone
 * pane, so an app only appears there once it has called
 * `AVCaptureDevice.requestAccess`. Sending someone to System Settings before
 * HQ has asked shows them a list HQ is not in — a dead end dressed up as
 * guidance. So `prompt` must offer the ask, and only `denied` may send them
 * to the pane.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import MediaPermissionCard from "./MediaPermissionCard.svelte";

let target: HTMLElement | null = null;
let app: Record<string, unknown> | null = null;

function render(props: Record<string, unknown>) {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(MediaPermissionCard, { target, props }) as Record<string, unknown>;
  flushSync();
  return target;
}

afterEach(() => {
  if (app) unmount(app);
  target?.remove();
  app = null;
  target = null;
});

function click(root: HTMLElement, testid: string) {
  const el = root.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`missing ${testid}`);
  el.click();
  flushSync();
}

describe("MediaPermissionCard", () => {
  it("asks macOS first when the user has never been asked", () => {
    const onrequest = vi.fn();
    const onopensettings = vi.fn();
    const root = render({
      device: "camera",
      status: "prompt",
      onrequest,
      onopensettings,
    });

    expect(
      root.querySelector('[data-testid="call-permission-primary"]')?.textContent,
    ).toContain("Allow camera");

    click(root, "call-permission-primary");
    expect(onrequest).toHaveBeenCalledWith("camera");
    // The pane would be a dead end here — HQ is not in the list yet.
    expect(onopensettings).not.toHaveBeenCalled();
  });

  it("sends the user to System Settings only once macOS has refused", () => {
    const onrequest = vi.fn();
    const onopensettings = vi.fn();
    const root = render({
      device: "camera",
      status: "denied",
      onrequest,
      onopensettings,
    });

    click(root, "call-permission-primary");
    expect(onopensettings).toHaveBeenCalledWith("camera");
    // Asking again is useless: macOS never re-prompts after a refusal.
    expect(onrequest).not.toHaveBeenCalled();
  });

  it("shows the grant steps only in the denied state", () => {
    const denied = render({ device: "camera", status: "denied" });
    expect(denied.querySelector('[data-testid="call-permission-steps"]')).not
      .toBeNull();
    if (app) unmount(app);
    target?.remove();
    app = null;

    const prompt = render({ device: "camera", status: "prompt" });
    expect(
      prompt.querySelector('[data-testid="call-permission-steps"]'),
    ).toBeNull();
  });

  it("treats a granted permission as a device fault, not a permission wall", () => {
    const onretry = vi.fn();
    const onopensettings = vi.fn();
    const root = render({
      device: "microphone",
      status: "granted",
      deviceError: "No microphone found.",
      onretry,
      onopensettings,
    });

    expect(
      root.querySelector('[data-testid="call-permission-body"]')?.textContent,
    ).toContain("No microphone found.");
    click(root, "call-permission-primary");
    expect(onretry).toHaveBeenCalledWith("microphone");
    expect(onopensettings).not.toHaveBeenCalled();
  });

  it("never fires an action twice while one is in flight", () => {
    const onrequest = vi.fn();
    const root = render({
      device: "camera",
      status: "prompt",
      busy: true,
      onrequest,
    });
    click(root, "call-permission-primary");
    expect(onrequest).not.toHaveBeenCalled();
  });

  it("says it is watching only while a denied grant could still land", () => {
    const root = render({
      device: "camera",
      status: "denied",
      watching: true,
    });
    expect(root.querySelector('[data-testid="call-permission-watching"]')).not
      .toBeNull();
  });
});
