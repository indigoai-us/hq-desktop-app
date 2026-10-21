// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";

import type { PlatformAdapter } from "@hq/platform";
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
  displayName: "Jonathan Drake",
  email: "jd@example.com",
  verified: true,
};

function mountWith(opts: {
  member: Record<string, unknown> | null;
  creator: Record<string, unknown> | null;
  onsectionchange?: (s: string) => void;
}): void {
  const adapter = {
    isAvailable: () => false,
    identity: {
      getProfile: async () => ({ ok: true as const, value: { profile: opts.member, entityName: "Jonathan Drake" } }),
      updateProfile: async () => ({ ok: true as const, value: { profile: {} } }),
    },
    marketplace: {
      getMyCreator: vi.fn(async () => ({ ok: true as const, value: opts.creator })),
      uploadCreatorAvatar: vi.fn(),
    },
  } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, {
    target: host,
    props: { profile, adapter, onsectionchange: opts.onsectionchange },
  });
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("Settings › Profile checklist", () => {
  it("lists what's left from the saved profile", async () => {
    mountWith({ member: { displayName: "Jonathan Drake" }, creator: null });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-checklist-count")?.textContent).toBe("1 of 3");
    });
    expect(q("profile-checklist-next")?.textContent).toContain("Add a photo");
  });

  it("when complete, nudges toward an unclaimed public profile and opens it", async () => {
    const onsectionchange = vi.fn();
    mountWith({
      member: {
        displayName: "Jonathan Drake",
        description: "Builds HQ",
        avatarUrl: "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/p/a.jpg",
      },
      creator: null,
      onsectionchange,
    });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-public-hint")?.textContent).toContain("Next: claim your public profile");
    });
    q("profile-public-hint")!.click();
    expect(onsectionchange).toHaveBeenCalledWith("public-profile");
  });

  it("stays quiet once the public profile has a photo and a bio", async () => {
    mountWith({
      member: {
        displayName: "Jonathan Drake",
        description: "Builds HQ",
        avatarUrl: "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/p/a.jpg",
      },
      creator: { handle: "drake", avatarUrl: "https://x/b.jpg", bio: "Packs for operators" },
    });
    await vi.waitFor(() => {
      flushSync();
      expect(q("settings-open-public-profile")).not.toBeNull();
    });
    expect(q("profile-public-hint")).toBeNull();
  });

  it("the progress line jumps to the About field", async () => {
    mountWith({ member: { displayName: "Jonathan Drake", avatarUrl: "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/p/a.jpg" }, creator: null });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-checklist-next")?.textContent).toContain("Add an About line");
    });
    q("profile-checklist-next")!.click();
    expect(document.activeElement).toBe(q("settings-description-input"));
  });

  it("clearing a saved field takes it off the count right away", async () => {
    mountWith({ member: { displayName: "Jonathan Drake", description: "Builds HQ" }, creator: null });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-checklist-count")?.textContent).toBe("2 of 3");
    });
    const name = q("settings-display-name-input") as HTMLInputElement;
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(q("profile-checklist-count")?.textContent).toBe("1 of 3");
    expect(q("profile-checklist-next")?.textContent).toContain("Add a display name");
  });

  it("highlights Save while there are unsaved changes", async () => {
    mountWith({ member: { displayName: "Jonathan Drake" }, creator: null });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-checklist-count")).not.toBeNull();
    });
    expect(q("settings-profile-save")!.classList.contains("attention")).toBe(false);
    const about = q("settings-description-input") as HTMLInputElement;
    about.value = "Builds HQ";
    about.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(q("settings-profile-save")!.classList.contains("attention")).toBe(true);
  });

  it("explains instead of silently skipping a save with an empty name", async () => {
    mountWith({ member: { displayName: "Jonathan Drake" }, creator: null });
    await vi.waitFor(() => {
      flushSync();
      expect(q("profile-checklist-count")).not.toBeNull();
    });
    const name = q("settings-display-name-input") as HTMLInputElement;
    name.value = "";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    q("settings-profile-save")!.click();
    flushSync();
    expect(q("settings-profile-error")?.textContent).toContain("Add a display name to save.");
    name.value = "Jon";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(q("settings-profile-error")).toBeNull();
  });

  it("the photo row links to the public profile", async () => {
    const onsectionchange = vi.fn();
    mountWith({ member: null, creator: null, onsectionchange });
    await vi.waitFor(() => {
      flushSync();
      expect(q("settings-open-public-profile")).not.toBeNull();
    });
    q("settings-open-public-profile")!.click();
    expect(onsectionchange).toHaveBeenCalledWith("public-profile");
  });
});
