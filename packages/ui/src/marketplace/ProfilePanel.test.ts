// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { ok, unavailable, type PlatformAdapter } from "@hq/platform";

// Canvas cropping isn't available in happy-dom; the upload path is under test.
vi.mock("../settings/profile-photo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings/profile-photo.js")>();
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

import ProfilePanel from "./ProfilePanel.svelte";

/**
 * PORT NOTE: the desktop-alt original mocked the Tauri IPC layer. Here the
 * panel receives the platform adapter as a prop, so the test builds a fake
 * adapter slice (marketplace + shell + capability flags).
 */
function fakeAdapter(
  overrides: Partial<Record<string, unknown>> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    marketplace: {
      getMyCreator: vi.fn(async () => ok<unknown>(null)),
      getCreatorProfile: vi.fn(async () =>
        ok<unknown>({ creator: { handle: "" }, listings: [] }),
      ),
      claimHandle: vi.fn(async () => unavailable()),
      updateCreatorProfile: vi.fn(async () => unavailable()),
      uploadCreatorAvatar: vi.fn(async () => unavailable()),
      ...((overrides.marketplace as object) ?? {}),
    },
    shell: {
      pickFile: vi.fn(async () => unavailable("desktop-only")),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

describe("ProfilePanel CSP-safe avatar fallback", () => {
  it("shows the initial, with no apology line, for presigned remote avatars", async () => {
    const adapter = fakeAdapter({
      marketplace: {
        getMyCreator: vi.fn(async () =>
          ok<unknown>({
            handle: "corey",
            displayName: "Corey",
            bio: "",
            socialLinks: [],
            tipUrl: null,
            avatarUrl: "https://cdn.example.com/corey.png",
          }),
        ),
        getCreatorProfile: vi.fn(async () =>
          ok<unknown>({
            creator: {
              handle: "corey",
              displayName: "Corey",
              bio: "",
              socialLinks: [],
              tipUrl: null,
              avatarUrl: "https://cdn.example.com/corey.png",
            },
            listings: [],
          }),
        ),
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProfilePanel, { target: host, props: { adapter } });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-edit"]')).not.toBeNull();
    });

    expect(host.querySelector('[data-testid="profile-avatar-img"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="profile-avatar-fallback"]')
        ?.textContent,
    ).toBe("C");
    // OWNER-R23: the initial stands in; no apology line.
    expect(
      host.querySelector('[data-testid="profile-avatar-preview-unavailable"]'),
    ).toBeNull();
    expect(host.textContent).not.toContain("unavailable in this version");
    expect(host.querySelector('img[src^="http"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="profile-preview-refresh"]',
      )
      ?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="profile-preview-name"]')?.textContent,
      ).toBe("Corey");
    });

    expect(
      host.querySelector('[data-testid="profile-preview-avatar-img"]'),
    ).toBeNull();
    expect(
      host.querySelector('[data-testid="profile-preview-avatar-fallback"]')
        ?.textContent,
    ).toBe("C");
    expect(
      host.querySelector('[data-testid="profile-preview-avatar-unavailable"]')
        ?.textContent,
    ).toContain("Avatar preview unavailable");
    expect(host.querySelector('img[src^="http"]')).toBeNull();
  });

  it("shows a saved avatar served from the marketplace assets host", async () => {
    const saved =
      "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/creators/drake/avatar?X-Amz-Signature=abc";
    const creator = {
      handle: "drake",
      displayName: "drake",
      bio: "",
      socialLinks: [],
      tipUrl: null,
      avatarUrl: saved,
    };
    const adapter = fakeAdapter({
      marketplace: {
        getMyCreator: vi.fn(async () => ok<unknown>(creator)),
        getCreatorProfile: vi.fn(async () =>
          ok<unknown>({ creator, listings: [] }),
        ),
      },
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProfilePanel, { target: host, props: { adapter } });

    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector('[data-testid="profile-avatar-img"]')
          ?.getAttribute("src"),
      ).toBe(saved);
    });
    expect(host.querySelector('[data-testid="profile-avatar-fallback"]')).toBeNull();

    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="profile-preview-refresh"]',
      )
      ?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(
        host
          .querySelector('[data-testid="profile-preview-avatar-img"]')
          ?.getAttribute("src"),
      ).toBe(saved);
    });
    expect(
      host.querySelector('[data-testid="profile-preview-avatar-unavailable"]'),
    ).toBeNull();
  });

  it("uploads a picked photo straight away and offers it as the profile photo", async () => {
    const saved =
      "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/creators/drake/avatar?sig=1";
    const creator = { handle: "drake", displayName: "drake", bio: "", socialLinks: [], tipUrl: null };
    const uploadCreatorAvatar = vi.fn(async () => ok<unknown>(saved));
    const updateCreatorProfile = vi.fn(async () => ok<unknown>(creator));
    const updateProfile = vi.fn(async () =>
      ok<unknown>({ profile: { avatarUrl: "https://example.invalid/x.jpg" } }),
    );
    const onprofilephotosaved = vi.fn();
    const adapter = {
      ...fakeAdapter({
        marketplace: {
          getMyCreator: vi.fn(async () => ok<unknown>(creator)),
          uploadCreatorAvatar,
          updateCreatorProfile,
        },
      }),
      isAvailable: () => true,
      identity: {
        getProfile: vi.fn(async () => ok<unknown>({ profile: null })),
        updateProfile,
      },
    } as unknown as PlatformAdapter;

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ProfilePanel, { target: host, props: { adapter, onprofilephotosaved } });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-avatar-input"]')).not.toBeNull();
    });
    const input = host.querySelector('[data-testid="profile-avatar-input"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-avatar-img"]')?.getAttribute("src")).toBe(saved);
    });
    expect(Array.from((uploadCreatorAvatar.mock.calls as unknown as Uint8Array[][])[0]?.[0] as Uint8Array)).toEqual([
      0x41, 0x42, 0x43,
    ]);
    // The photo doesn't wait for Save profile.
    expect(updateCreatorProfile).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-photo-offer-text"]')?.textContent).toBe(
        "Teammates still see your initials.",
      );
    });
    expect(
      host.querySelector('[data-testid="profile-photo-offer-action"]')?.textContent?.trim(),
    ).toBe("Use as profile photo");
    (host.querySelector('[data-testid="profile-photo-offer-action"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-photo-offer-text"]')?.textContent).toBe(
        "Now your profile photo.",
      );
    });
    expect(updateProfile).toHaveBeenCalledWith({ avatarBase64: "QUJD" });
    expect(onprofilephotosaved).toHaveBeenCalledWith("https://example.invalid/x.jpg");
  });
});
