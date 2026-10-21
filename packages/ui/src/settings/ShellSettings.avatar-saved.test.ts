// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync, tick } from "svelte";

import type { PlatformAdapter } from "@hq/platform";

// Canvas cropping is not available in happy-dom; the save path is what's under test.
vi.mock("./avatar-image.js", () => ({
  avatarBase64FromFile: vi.fn(async () => ({
    base64: "QUJD",
    previewDataUrl: "data:image/jpeg;base64,QUJD",
  })),
}));

import ShellSettings from "./ShellSettings.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const profile = {
  initial: "J",
  fullName: "Jonathan Drake",
  displayName: "",
  email: "jd@example.com",
  verified: true,
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

function mountWith(
  update: () => Promise<unknown>,
  onavatarsaved: (src: string) => void,
): void {
  const adapter = {
    isAvailable: () => false,
    identity: {
      getProfile: async () => ({
        ok: true as const,
        value: { profile: null, entityName: "Jonathan Drake" },
      }),
      updateProfile: update,
    },
  } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: { profile, adapter, onavatarsaved },
  });
}

async function pickPhotoAndSave(): Promise<void> {
  await settle();
  const input = host.querySelector(
    '[data-testid="settings-photo-input"]',
  ) as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", {
    type: "image/png",
  });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  (
    host.querySelector('[data-testid="settings-profile-save"]') as HTMLButtonElement
  ).click();
  await settle();
}

describe("ShellSettings profile photo save", () => {
  it("hands the saved photo URL to the app so it shows everywhere", async () => {
    const saved =
      "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/prs_jd/a.jpg?sig=1";
    const update = vi.fn(async () => ({
      ok: true as const,
      value: { profile: { avatarUrl: saved } },
    }));
    const onavatarsaved = vi.fn();
    mountWith(update, onavatarsaved);

    await pickPhotoAndSave();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ avatarBase64: "QUJD" }),
    );
    expect(onavatarsaved).toHaveBeenCalledWith(saved);
  });

  it("falls back to the local preview when the server echoes no URL", async () => {
    const onavatarsaved = vi.fn();
    mountWith(
      async () => ({ ok: true as const, value: { profile: {} } }),
      onavatarsaved,
    );

    await pickPhotoAndSave();

    expect(onavatarsaved).toHaveBeenCalledWith("data:image/jpeg;base64,QUJD");
  });

  it("does not report a photo when the save fails", async () => {
    const onavatarsaved = vi.fn();
    mountWith(
      async () => ({ ok: false as const, message: "nope" }),
      onavatarsaved,
    );

    await pickPhotoAndSave();

    expect(onavatarsaved).not.toHaveBeenCalled();
  });
});
