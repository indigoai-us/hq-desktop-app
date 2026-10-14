// @vitest-environment happy-dom
// OWNER-R23: the marketplace creator profile lives in Settings as "Public
// profile", directly under Profile. Library no longer lists it, the old
// Library route redirects, and Save uses the same (mocked) creator write.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, unavailable, type PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";
import { canonicalizeDestination } from "../shell/navigation-history.js";
import { buildLibraryNavRows } from "../library/library-overlay-model.js";

const creator = {
  handle: "ada",
  displayName: "Ada",
  bio: "Builds engines",
  socialLinks: [],
  tipUrl: null,
  avatarUrl: null,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  localStorage.clear();
});

function fakeAdapter(updateCreatorProfile = vi.fn(async () => ok<unknown>(creator))) {
  return {
    adapter: {
      kind: "web",
      isAvailable: () => false,
      identity: { getProfile: async () => ({ ok: true, value: { profile: { displayName: "Ada", email: "ada@example.com" } } }) },
      sessions: {},
      marketplace: {
        getMyCreator: vi.fn(async () => ok<unknown>(creator)),
        getCreatorProfile: vi.fn(async () => ok<unknown>({ creator, listings: [] })),
        claimHandle: vi.fn(async () => unavailable()),
        updateCreatorProfile,
        uploadCreatorAvatar: vi.fn(async () => unavailable()),
      },
      shell: { pickFile: vi.fn(async () => unavailable("desktop-only")) },
    } as unknown as PlatformAdapter,
    updateCreatorProfile,
  };
}

function mountSettings(adapter: PlatformAdapter, props: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, { target: host, props: { profile: null, adapter, ...props } as never });
  flushSync();
}

describe("Public profile in Settings (OWNER-R23)", () => {
  it("Library list has no Profile row", () => {
    const rows = buildLibraryNavRows({ skills: [], workers: [] } as never);
    expect(rows.map((r) => r.id)).not.toContain("profile");
    expect(rows.map((r) => r.label)).not.toContain("Profile");
  });

  it("Settings lists Public profile directly under Profile", () => {
    mountSettings(fakeAdapter().adapter);
    const nav = [...host.querySelectorAll('[data-testid^="settings-nav-"]')].map((el) => el.getAttribute("data-testid")!.slice("settings-nav-".length));
    expect(nav.slice(0, 2)).toEqual(["profile", "public-profile"]);
    expect(host.querySelector('[data-testid="settings-nav-public-profile"]')?.textContent).toContain("Public profile");
  });

  it("the old Library profile route redirects to Settings > Public profile", () => {
    expect(canonicalizeDestination({ kind: "library", tab: "profile" } as never)).toEqual({ kind: "settings", section: "public-profile" });
    expect(canonicalizeDestination({ kind: "library", tab: "marketplace" } as never)).toMatchObject({ kind: "library", tab: "marketplace" });
  });

  it("renders sentence-case labels and the new tip helper, and Save uses the creator write", async () => {
    const { adapter, updateCreatorProfile } = fakeAdapter();
    mountSettings(adapter, { initialSection: "public-profile" });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-edit"]')).not.toBeNull();
    });
    expect(host.querySelector('label[for="profile-bio"]')?.textContent).toBe("Public bio");
    expect(host.textContent).toContain("Shown on your public profile. Web links only.");
    expect(host.textContent).not.toContain("unavailable in this version");
    expect(host.querySelector('[data-testid="profile-avatar-fallback"]')?.textContent?.trim()).toBe("A");
    expect(host.querySelectorAll('[data-testid="profile-save"]')).toHaveLength(1);
    host.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click();
    await vi.waitFor(() => expect(updateCreatorProfile).toHaveBeenCalledTimes(1));
    expect(updateCreatorProfile.mock.calls[0]).toBeDefined();
  });
});
