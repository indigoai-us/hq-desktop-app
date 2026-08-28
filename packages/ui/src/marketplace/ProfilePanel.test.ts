// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { ok, unavailable, type PlatformAdapter } from "@hq/platform";
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
  it("shows initials and an explicit unavailable state for presigned remote avatars", async () => {
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
    expect(
      host.querySelector('[data-testid="profile-avatar-preview-unavailable"]')
        ?.textContent,
    ).toContain("preview unavailable");
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
});
