// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";

import type { PlatformAdapter } from "@hq/platform";

// Canvas cropping is not available in happy-dom; the save path is what's under test.
vi.mock("./profile-photo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./profile-photo.js")>();
  return {
    ...actual,
    loadPhotoSource: vi.fn(async (input: Blob | string) => ({
      url: typeof input === "string" ? input : "data:image/png;base64,PICKED",
      width: 600,
      height: 600,
    })),
    renderPhoto: vi.fn(async () => ({
      base64: "QUJD",
      previewDataUrl: "data:image/jpeg;base64,QUJD",
    })),
    photoFingerprint: vi.fn(async () => Array.from({ length: 256 }, () => 100)),
  };
});

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

function mountWith(
  update: (input: Record<string, unknown>) => Promise<unknown>,
  onavatarsaved: (src: string) => void,
  marketplace?: Record<string, unknown>,
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
    ...(marketplace ? { marketplace } : {}),
  } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: { profile, adapter, onavatarsaved },
  });
}

async function pickPhoto(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('[data-testid="settings-photo-input"]')).not.toBeNull();
  });
  const input = host.querySelector('[data-testid="settings-photo-input"]') as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ShellSettings profile photo", () => {
  it("saves a picked photo without pressing Save and tells the app", async () => {
    const saved =
      "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/prs_jd/a.jpg?sig=1";
    const update = vi.fn(async () => ({ ok: true as const, value: { profile: { avatarUrl: saved } } }));
    const onavatarsaved = vi.fn();
    mountWith(update, onavatarsaved);

    await pickPhoto();
    await vi.waitFor(() => expect(onavatarsaved).toHaveBeenCalledWith(saved));

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ avatarBase64: "QUJD" });
    // The name/about Save button stays clean: the photo isn't pending.
    flushSync();
    expect(
      (host.querySelector('[data-testid="settings-profile-save"]') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("falls back to the local preview when the server echoes no URL", async () => {
    const onavatarsaved = vi.fn();
    mountWith(async () => ({ ok: true as const, value: { profile: {} } }), onavatarsaved);

    await pickPhoto();
    await vi.waitFor(() => expect(onavatarsaved).toHaveBeenCalledWith("data:image/jpeg;base64,QUJD"));
  });

  it("does not report a photo when the save fails", async () => {
    vi.useFakeTimers();
    const onavatarsaved = vi.fn();
    mountWith(async () => ({ ok: false as const, message: "nope" }), onavatarsaved);

    await pickPhoto();
    await vi.advanceTimersByTimeAsync(8000);
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-photo-retry"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="settings-photo-status"]')?.textContent).not.toContain("nope");
    expect(onavatarsaved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("offers the photo to a claimed public profile with no photo", async () => {
    const uploadCreatorAvatar = vi.fn(async () => ({ ok: true as const, value: { avatarUrl: "x" } }));
    mountWith(
      async () => ({ ok: true as const, value: { profile: {} } }),
      vi.fn(),
      {
        getMyCreator: vi.fn(async () => ({ ok: true as const, value: { handle: "drake", avatarUrl: null } })),
        uploadCreatorAvatar,
      },
    );

    await pickPhoto();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-photo-offer-text"]')?.textContent).toBe(
        "Your public profile has no photo.",
      );
    });
    (host.querySelector('[data-testid="settings-photo-offer-action"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="settings-photo-offer-text"]')?.textContent).toBe(
        "Added to your public profile.",
      );
    });
    const sent = (uploadCreatorAvatar.mock.calls as unknown as Uint8Array[][])[0]?.[0] as Uint8Array;
    expect(sent).toBeInstanceOf(Uint8Array);
    expect(Array.from(sent)).toEqual([0x41, 0x42, 0x43]);
  });

  it("makes no offer before a public profile handle is claimed", async () => {
    const getMyCreator = vi.fn(async () => ({ ok: true as const, value: null }));
    mountWith(async () => ({ ok: true as const, value: { profile: {} } }), vi.fn(), {
      getMyCreator,
      uploadCreatorAvatar: vi.fn(),
    });

    await pickPhoto();
    await vi.waitFor(() => expect(getMyCreator).toHaveBeenCalled());
    flushSync();
    expect(host.querySelector('[data-testid="settings-photo-offer"]')).toBeNull();
  });
});
