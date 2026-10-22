// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

// Canvas and image decoding aren't available in happy-dom; the row's
// behavior is what's under test, so the DOM helpers are stubbed.
const dom = vi.hoisted(() => ({
  renders: 0,
  fingerprints: new Map<string, number[]>(),
}));

vi.mock("./profile-photo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./profile-photo.js")>();
  return {
    ...actual,
    loadPhotoSource: vi.fn(async (input: Blob | string) => ({
      url: typeof input === "string" ? input : "data:image/png;base64,PICKED",
      width: 800,
      height: 600,
    })),
    renderPhoto: vi.fn(async (_source: unknown, crop: { zoom: number }) => {
      dom.renders += 1;
      const tag = `R${dom.renders}Z${crop.zoom}`;
      return { base64: tag, previewDataUrl: `data:image/jpeg;base64,${tag}` };
    }),
    photoFingerprint: vi.fn(async (source: { url: string }) =>
      dom.fingerprints.get(source.url) ?? Array.from({ length: 256 }, () => 100),
    ),
  };
});

import ProfilePhotoField from "./ProfilePhotoField.svelte";
import { PhotoError, type OtherProfile } from "./profile-photo.js";

const MEMBER_URL =
  "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/prs_1/a.jpg?sig=1";
const LOCAL_PHOTO = "data:image/jpeg;base64,TE9DQUw=";
const OTHER_LOCAL = "data:image/jpeg;base64,T1RIRVI=";
const OTHER_URL =
  "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/creators/drake/b.jpg?sig=2";

const copy = {
  emptyText: "Your public profile has no photo.",
  emptyAction: "Use on public profile",
  emptyDone: "Added to your public profile.",
  diffText: "Your public profile shows a different photo.",
  diffAction: "Update public profile",
  diffDone: "Public profile photo updated.",
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  dom.renders = 0;
  dom.fingerprints.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function render(props: Record<string, unknown>): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ProfilePhotoField, {
    target: host,
    props: {
      photoUrl: null,
      initial: "J",
      testid: "p",
      imgTestid: "p-img",
      fallbackTestid: "p-fallback",
      inputTestid: "p-input",
      changeTestid: "p-change",
      save: vi.fn(async () => ({ ok: true, url: MEMBER_URL })),
      ...props,
    },
  });
  flushSync();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function pick(): Promise<void> {
  const input = q("p-input") as HTMLInputElement;
  const file = new File([new Uint8Array([1, 2, 3])], "me.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function settle(check: () => void): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    check();
  });
}

describe("ProfilePhotoField", () => {
  it("saves a picked photo straight away and reports it", async () => {
    const save = vi.fn(async () => ({ ok: true as const, url: MEMBER_URL }));
    const onsaved = vi.fn();
    render({ save, onsaved });

    await pick();
    await settle(() => expect(q("p-status")?.textContent).toContain("Photo updated"));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ base64: "R1Z1" }));
    expect(onsaved).toHaveBeenCalledWith(MEMBER_URL);
    expect(q("p-img")?.getAttribute("src")).toBe(MEMBER_URL);
    // Nothing to go back to: there was no photo before.
    expect(q("p-undo")).toBeNull();
  });

  it("plays the HQ glow after a save, and not after a failed one", async () => {
    render({});
    expect(q("p-glow")).toBeNull();
    await pick();
    await settle(() => expect(q("p-glow")).not.toBeNull());
  });

  it("no glow when the save fails", async () => {
    vi.useFakeTimers();
    render({ save: vi.fn(async () => ({ ok: false as const })) });
    await pick();
    await vi.advanceTimersByTimeAsync(8000);
    await settle(() => expect(q("p-status")?.textContent).toContain("Couldn't save"));
    expect(q("p-glow")).toBeNull();
  });

  it("keeps the old photo when the save fails", async () => {
    vi.useFakeTimers();
    const onsaved = vi.fn();
    render({ photoUrl: MEMBER_URL, save: vi.fn(async () => ({ ok: false as const })), onsaved });

    await pick();
    await vi.advanceTimersByTimeAsync(8000);
    await settle(() => expect(q("p-retry")).not.toBeNull());

    expect(onsaved).not.toHaveBeenCalled();
    expect(q("p-img")?.getAttribute("src")).toBe(MEMBER_URL);
  });

  it("retries a failed save quietly and succeeds without showing an error", async () => {
    vi.useFakeTimers();
    const save = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true, url: null });
    render({ save });
    await pick();
    await settle(() => expect(save).toHaveBeenCalledTimes(1));
    expect(q("p-status")?.textContent).toContain("Saving");
    await vi.advanceTimersByTimeAsync(1000);
    await settle(() => expect(q("p-status")?.textContent).toContain("Photo updated"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("after the retries run out, Retry re-sends the same photo without picking again", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ ok: false });
    render({ save });
    await pick();
    await vi.advanceTimersByTimeAsync(8000);
    await settle(() => expect(q("p-retry")).not.toBeNull());
    expect(save).toHaveBeenCalledTimes(4);
    expect(q("p-status")?.textContent).toContain("Couldn't save");
    expect(q("p-status")!.classList.contains("err")).toBe(false);

    save.mockResolvedValue({ ok: true, url: null });
    q("p-retry")!.click();
    await settle(() => expect(q("p-status")?.textContent).toContain("Photo updated"));
    expect(save).toHaveBeenCalledTimes(5);
    expect(save.mock.calls[4]![0]).toEqual(save.mock.calls[0]![0]);
    expect(dom.renders).toBe(1);
  });

  it("never shows raw browser error text for a picked file", async () => {
    const { loadPhotoSource } = await import("./profile-photo.js");
    vi.mocked(loadPhotoSource).mockRejectedValueOnce(new DOMException("The operation is insecure."));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render({});
    await pick();
    await settle(() =>
      expect(q("p-status")?.textContent).toContain("Couldn't read that image. Try another photo."),
    );
    expect(q("p-status")?.textContent).not.toContain("insecure");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("shows the app's own wording for a known photo problem", async () => {
    const { loadPhotoSource } = await import("./profile-photo.js");
    vi.mocked(loadPhotoSource).mockRejectedValueOnce(new PhotoError("That file isn't a readable image."));
    render({});
    await pick();
    await settle(() => expect(q("p-status")?.textContent).toContain("That file isn't a readable image."));
  });

  it("Undo puts the previous photo back", async () => {
    const save = vi.fn(async () => ({ ok: true as const, url: null }));
    render({ photoUrl: LOCAL_PHOTO, save });

    await pick();
    await settle(() => expect(q("p-undo")).not.toBeNull());
    q("p-undo")!.click();
    await settle(() => expect(save).toHaveBeenCalledTimes(2));

    const { loadPhotoSource } = await import("./profile-photo.js");
    expect(loadPhotoSource).toHaveBeenCalledWith(LOCAL_PHOTO);
  });

  it("Undo goes back to a saved server photo from an earlier session", async () => {
    const save = vi.fn(async () => ({ ok: true as const, url: null }));
    render({ photoUrl: MEMBER_URL, save });
    await pick();
    await settle(() => expect(q("p-undo")).not.toBeNull());
    q("p-undo")!.click();
    await settle(() => expect(save).toHaveBeenCalledTimes(2));
    const { loadPhotoSource } = await import("./profile-photo.js");
    expect(loadPhotoSource).toHaveBeenCalledWith(MEMBER_URL);
  });

  it("shows Adjust for a saved server photo and opens the crop editor on it", async () => {
    render({ photoUrl: MEMBER_URL });
    expect(q("p-adjust")).not.toBeNull();
    q("p-adjust")!.click();
    await settle(() => expect(q("photo-crop-editor")).not.toBeNull());
    const { loadPhotoSource } = await import("./profile-photo.js");
    expect(loadPhotoSource).toHaveBeenCalledWith(MEMBER_URL);
  });

  it("if a saved photo can't be loaded, says to pick it again instead of showing raw errors", async () => {
    const { loadPhotoSource } = await import("./profile-photo.js");
    vi.mocked(loadPhotoSource).mockRejectedValueOnce(new TypeError("Load failed"));
    render({ photoUrl: MEMBER_URL });
    q("p-adjust")!.click();
    await settle(() =>
      expect(q("p-status")?.textContent).toContain("Couldn't open this photo. Pick it again to adjust it."),
    );
    expect(q("p-status")?.textContent).not.toContain("Load failed");
    expect(q("photo-crop-editor")).toBeNull();
  });

  it("keeps the picker for a photo URL it can't read", async () => {
    render({ photoUrl: "asset://localhost/me.jpg" });
    expect(q("p-adjust")).toBeNull();
    const input = q("p-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    q("p-avatar")!.click();
    expect(click).toHaveBeenCalled();
    expect(q("photo-crop-editor")).toBeNull();
  });

  it("Adjust opens the crop in the row; Done saves the new crop, Cancel saves nothing", async () => {
    const save = vi.fn(async () => ({ ok: true as const, url: null }));
    render({ photoUrl: LOCAL_PHOTO, save });

    q("p-adjust")!.click();
    await settle(() => expect(q("photo-crop-editor")).not.toBeNull());
    q("photo-crop-cancel")!.click();
    flushSync();
    expect(q("photo-crop-editor")).toBeNull();
    expect(save).not.toHaveBeenCalled();

    q("p-adjust")!.click();
    await settle(() => expect(q("photo-crop-editor")).not.toBeNull());
    const zoom = q("photo-crop-zoom") as HTMLInputElement;
    zoom.value = "2";
    zoom.dispatchEvent(new Event("input", { bubbles: true }));
    q("photo-crop-done")!.click();
    await settle(() => expect(q("p-status")?.textContent).toContain("Saved"));

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ base64: "R1Z2" }));
    expect(q("photo-crop-editor")).toBeNull();
  });

  it("offers the photo to an other profile that has none, and applies it", async () => {
    const apply = vi.fn(async () => true);
    const other: OtherProfile = { current: vi.fn(async () => null), apply, copy };
    render({ other });

    await pick();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.emptyText));
    expect(q("p-offer-action")?.textContent?.trim()).toBe(copy.emptyAction);

    q("p-offer-action")!.click();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.emptyDone));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ base64: "R1Z1" }));
    expect(q("p-offer-action")).toBeNull();
  });

  it("offers an update only when the other profile's photo is different", async () => {
    const other: OtherProfile = { current: vi.fn(async () => OTHER_LOCAL), apply: vi.fn(async () => true), copy };
    dom.fingerprints.set(OTHER_LOCAL, Array.from({ length: 256 }, () => 220));
    render({ other });

    await pick();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.diffText));
    expect(q("p-offer-action")?.textContent?.trim()).toBe(copy.diffAction);
  });

  it("stays quiet when the other profile already has the same photo", async () => {
    const current = vi.fn(async () => OTHER_LOCAL);
    render({ other: { current, apply: vi.fn(async () => true), copy } });

    await pick();
    await settle(() => expect(current).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(q("p-offer")).toBeNull();
  });

  it("offers an update when the other profile's saved server photo is different", async () => {
    const current = vi.fn(async () => OTHER_URL);
    dom.fingerprints.set(OTHER_URL, Array.from({ length: 256 }, () => 220));
    render({ other: { current, apply: vi.fn(async () => true), copy } });
    await pick();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.diffText));
    const { loadPhotoSource } = await import("./profile-photo.js");
    expect(loadPhotoSource).toHaveBeenCalledWith(OTHER_URL);
  });

  it("stays quiet when the other profile's saved server photo matches", async () => {
    const current = vi.fn(async () => OTHER_URL);
    render({ other: { current, apply: vi.fn(async () => true), copy } });
    await pick();
    await settle(() => expect(current).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(q("p-offer")).toBeNull();
  });

  it("makes no offer when the other profile's photo can't be loaded", async () => {
    const { loadPhotoSource } = await import("./profile-photo.js");
    // The picked file and the new photo load; the other profile's photo doesn't.
    vi.mocked(loadPhotoSource).mockImplementation(async (input: Blob | string) => {
      if (input === OTHER_URL) throw new TypeError("Load failed");
      return { url: typeof input === "string" ? input : "data:image/png;base64,PICKED", width: 800, height: 600 };
    });
    const current = vi.fn(async () => OTHER_URL);
    render({ other: { current, apply: vi.fn(async () => true), copy } });
    await pick();
    await settle(() => expect(current).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    flushSync();
    expect(q("p-offer")).toBeNull();
  });

  it("stays quiet when there is no other profile", async () => {
    const current = vi.fn(async () => undefined);
    render({ other: { current, apply: vi.fn(async () => true), copy } });

    await pick();
    await settle(() => expect(current).toHaveBeenCalled());
    flushSync();
    expect(q("p-offer")).toBeNull();
  });

  it("retries copying to the other profile, then leaves the button to try again", async () => {
    vi.useFakeTimers();
    const apply = vi.fn().mockResolvedValue(false);
    render({ other: { current: vi.fn(async () => null), apply, copy } });
    await pick();
    await settle(() => expect(q("p-offer-action")).not.toBeNull());
    q("p-offer-action")!.click();
    await vi.advanceTimersByTimeAsync(8000);
    await settle(() => expect(q("p-offer-text")?.textContent).toBe("Couldn't update it."));
    expect(apply).toHaveBeenCalledTimes(4);
    const action = q("p-offer-action") as HTMLButtonElement;
    expect(action.disabled).toBe(false);

    apply.mockResolvedValue(true);
    action.click();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.emptyDone));
    expect(apply).toHaveBeenCalledTimes(5);
  });

  it("Not now hides the offer", async () => {
    render({ other: { current: vi.fn(async () => null), apply: vi.fn(async () => true), copy } });
    await pick();
    await settle(() => expect(q("p-offer")).not.toBeNull());
    q("p-offer-dismiss")!.click();
    flushSync();
    expect(q("p-offer")).toBeNull();
  });

  it("reports while the offer is waiting on an answer", async () => {
    const onphotobusy = vi.fn();
    render({ other: { current: vi.fn(async () => null), apply: vi.fn(async () => true), copy }, onphotobusy });
    expect(onphotobusy).toHaveBeenLastCalledWith(false);

    await pick();
    await settle(() => expect(q("p-offer")).not.toBeNull());
    expect(onphotobusy).toHaveBeenLastCalledWith(true);

    q("p-offer-action")!.click();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.emptyDone));
    expect(onphotobusy).toHaveBeenLastCalledWith(false);
  });

  it("the avatar shows the crop live while adjusting, and goes back on Cancel", async () => {
    render({ photoUrl: LOCAL_PHOTO, size: 64 });
    q("p-adjust")!.click();
    await settle(() => expect(q("p-live")).not.toBeNull());
    expect(q("p-img")).toBeNull();
    const before = q("p-live")!.getAttribute("style");

    const zoom = q("photo-crop-zoom") as HTMLInputElement;
    zoom.value = "2";
    zoom.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(q("p-live")!.getAttribute("style")).not.toBe(before);

    q("photo-crop-cancel")!.click();
    flushSync();
    expect(q("p-live")).toBeNull();
    expect(q("p-img")).not.toBeNull();
  });

  it("reports busy while the crop is open", async () => {
    const onphotobusy = vi.fn();
    render({ photoUrl: LOCAL_PHOTO, onphotobusy });
    expect(onphotobusy).toHaveBeenLastCalledWith(false);
    q("p-adjust")!.click();
    await settle(() => expect(q("photo-crop-editor")).not.toBeNull());
    expect(onphotobusy).toHaveBeenLastCalledWith(true);
    q("photo-crop-cancel")!.click();
    flushSync();
    expect(onphotobusy).toHaveBeenLastCalledWith(false);
  });

  it("reports the offer closed after Not now", async () => {
    const onphotobusy = vi.fn();
    render({ other: { current: vi.fn(async () => null), apply: vi.fn(async () => true), copy }, onphotobusy });
    await pick();
    await settle(() => expect(onphotobusy).toHaveBeenLastCalledWith(true));
    q("p-offer-dismiss")!.click();
    flushSync();
    expect(onphotobusy).toHaveBeenLastCalledWith(false);
  });

  it("display-only mode shows the photo without controls", () => {
    render({ photoUrl: MEMBER_URL, editable: false });
    expect(q("p-img")?.getAttribute("src")).toBe(MEMBER_URL);
    expect(q("p-change")).toBeNull();
    expect(q("p-input")).toBeNull();
  });
});
