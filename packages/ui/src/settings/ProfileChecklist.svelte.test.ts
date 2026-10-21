// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ProfileChecklist from "./ProfileChecklist.svelte";
import {
  profileChecklistSteps,
  publicProfileHint,
  publicProfileStateFrom,
  type PublicProfileState,
} from "./profile-checklist.js";

describe("profile progress model", () => {
  it("ticks each saved step", () => {
    const steps = profileChecklistSteps({ displayName: "Jonathan", hasPhoto: false, about: "  " });
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ["name", true],
      ["photo", false],
      ["about", false],
    ]);
  });

  it("reads the public profile from the creator payload", () => {
    expect(publicProfileStateFrom(null)).toEqual({ kind: "unclaimed" });
    expect(publicProfileStateFrom({ code: "NO_CREATOR" })).toEqual({ kind: "unclaimed" });
    expect(publicProfileStateFrom({ handle: "drake", avatarUrl: "https://x", bio: "Builds HQ" })).toEqual({
      kind: "claimed",
      hasPhoto: true,
      hasBio: true,
    });
    expect(publicProfileStateFrom({ handle: "drake", avatarUrl: null, bio: "" })).toEqual({
      kind: "claimed",
      hasPhoto: false,
      hasBio: false,
    });
  });

  it("nudges toward what the public profile is missing, and stays quiet when it's done", () => {
    expect(publicProfileHint({ kind: "unknown" })).toBeNull();
    expect(publicProfileHint({ kind: "unclaimed" })).toBe("Next: claim your public profile");
    expect(publicProfileHint({ kind: "claimed", hasPhoto: false, hasBio: false })).toBe(
      "Next: add a photo and bio to your public profile",
    );
    expect(publicProfileHint({ kind: "claimed", hasPhoto: true, hasBio: false })).toBe(
      "Next: add a bio to your public profile",
    );
    expect(publicProfileHint({ kind: "claimed", hasPhoto: false, hasBio: true })).toBe(
      "Next: add a photo to your public profile",
    );
    expect(publicProfileHint({ kind: "claimed", hasPhoto: true, hasBio: true })).toBeNull();
  });
});

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

function renderWith(props: {
  photo: boolean;
  about: string;
  publicProfile?: PublicProfileState;
  storage?: ReturnType<typeof memoryStorage>;
  onstep?: (id: string) => void;
  onopenpublic?: () => void;
  holdHint?: boolean;
}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const state = $state({ photo: props.photo, about: props.about, holdHint: props.holdHint ?? false });
  component = mount(ProfileChecklist, {
    target: host,
    props: {
      get steps() {
        return profileChecklistSteps({ displayName: "Jonathan", hasPhoto: state.photo, about: state.about });
      },
      publicProfile: props.publicProfile ?? { kind: "unclaimed" },
      storage: props.storage ?? memoryStorage(),
      onstep: props.onstep,
      onopenpublic: props.onopenpublic ?? (() => {}),
      get holdHint() {
        return state.holdHint;
      },
    },
  });
  flushSync();
  return state;
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("ProfileChecklist line", () => {
  it("shows progress and the next step, and goes to it on click", () => {
    const onstep = vi.fn();
    renderWith({ photo: false, about: "", onstep });
    expect(q("profile-checklist-next")?.textContent).toContain("1 of 3");
    expect(q("profile-checklist-next")?.textContent).toContain("Add a photo");
    expect(q("profile-public-hint")).toBeNull();
    // The way to the public profile stays on the line while steps are left.
    expect(q("settings-open-public-profile")?.textContent).toContain("Public profile");
    q("profile-checklist-next")!.click();
    expect(onstep).toHaveBeenCalledWith("photo");
  });

  it("celebrates once when the last step is saved, then nudges toward the public profile", () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const onopenpublic = vi.fn();
    const state = renderWith({ photo: false, about: "Builds HQ", storage, onopenpublic });

    state.photo = true;
    flushSync();
    expect(q("profile-checklist-complete")?.textContent).toContain("Profile complete");
    expect(storage.map.get("hq.settings.profile-complete-celebrated")).toBe("1");

    vi.advanceTimersByTime(3300);
    flushSync();
    expect(q("profile-checklist-complete")).toBeNull();
    expect(q("profile-public-hint")?.textContent).toContain("Next: claim your public profile");
    q("profile-public-hint")!.click();
    expect(onopenpublic).toHaveBeenCalledTimes(1);
  });

  it("shows the plain link once both profiles are complete", () => {
    renderWith({
      photo: true,
      about: "Builds HQ",
      publicProfile: { kind: "claimed", hasPhoto: true, hasBio: true },
    });
    expect(q("profile-checklist-complete")).toBeNull();
    expect(q("profile-public-hint")).toBeNull();
    expect(q("settings-open-public-profile")?.textContent).toContain("Public profile");
  });

  it("holds the public profile nudge while asked to, then shows what's still missing", () => {
    const state = renderWith({
      photo: true,
      about: "Builds HQ",
      publicProfile: { kind: "claimed", hasPhoto: false, hasBio: false },
      storage: memoryStorage({ "hq.settings.profile-complete-celebrated": "1" }),
      holdHint: true,
    });
    expect(q("profile-public-hint")).toBeNull();
    expect(q("settings-open-public-profile")?.textContent).toContain("Public profile");

    state.holdHint = false;
    flushSync();
    expect(q("profile-public-hint")?.textContent).toContain("Next: add a photo and bio to your public profile");
  });

  it("never leaves 'Profile complete' stuck when a field is cleared mid-celebration", () => {
    vi.useFakeTimers();
    const state = renderWith({ photo: false, about: "Builds HQ" });
    state.photo = true;
    flushSync();
    expect(q("profile-checklist-complete")).not.toBeNull();

    state.about = "";
    flushSync();
    expect(q("profile-checklist-complete")).toBeNull();
    state.about = "Builds HQ";
    flushSync();
    vi.advanceTimersByTime(3300);
    flushSync();
    expect(q("profile-checklist-complete")).toBeNull();
    expect(q("profile-public-hint")).not.toBeNull();
  });

  it("doesn't celebrate later for a profile that was already complete when opened", () => {
    const storage = memoryStorage();
    const state = renderWith({ photo: true, about: "Builds HQ", storage });
    expect(storage.map.get("hq.settings.profile-complete-celebrated")).toBe("1");
    state.about = "";
    flushSync();
    state.about = "Builds HQ";
    flushSync();
    expect(q("profile-checklist-complete")).toBeNull();
  });

  it("doesn't replay the celebration once it has been seen", () => {
    const storage = memoryStorage({ "hq.settings.profile-complete-celebrated": "1" });
    const state = renderWith({ photo: false, about: "Builds HQ", storage });
    state.photo = true;
    flushSync();
    expect(q("profile-checklist-complete")).toBeNull();
    expect(q("profile-public-hint")).not.toBeNull();
  });
});
