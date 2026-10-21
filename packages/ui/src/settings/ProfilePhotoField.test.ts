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
import type { OtherProfile } from "./profile-photo.js";

const MEMBER_URL =
  "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/prs_1/a.jpg?sig=1";
const LOCAL_PHOTO = "data:image/jpeg;base64,TE9DQUw=";
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
    render({ save: vi.fn(async () => ({ ok: false as const })) });
    await pick();
    await settle(() => expect(q("p-status")?.textContent).toContain("Couldn't save"));
    expect(q("p-glow")).toBeNull();
  });

  it("shows an error and keeps the old photo when the save fails", async () => {
    const onsaved = vi.fn();
    render({ photoUrl: MEMBER_URL, save: vi.fn(async () => ({ ok: false as const })), onsaved });

    await pick();
    await settle(() => expect(q("p-status")?.textContent).toContain("Couldn't save your photo"));

    expect(onsaved).not.toHaveBeenCalled();
    expect(q("p-img")?.getAttribute("src")).toBe(MEMBER_URL);
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

  it("offers no Undo back to a server photo it cannot read", async () => {
    render({ photoUrl: MEMBER_URL, save: vi.fn(async () => ({ ok: true as const, url: null })) });
    await pick();
    await settle(() => expect(q("p-status")?.textContent).toContain("Photo updated"));
    expect(q("p-undo")).toBeNull();
  });

  it("hides Adjust for a server photo it cannot read; clicking the photo opens the picker", async () => {
    render({ photoUrl: MEMBER_URL });
    expect(q("p-adjust")).toBeNull();
    const input = q("p-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    q("p-avatar")!.click();
    expect(click).toHaveBeenCalled();
    expect(q("photo-crop-editor")).toBeNull();
    const { loadPhotoSource } = await import("./profile-photo.js");
    expect(loadPhotoSource).not.toHaveBeenCalled();
  });

  it("shows Adjust once a photo is picked, even over a server photo", async () => {
    render({ photoUrl: MEMBER_URL });
    await pick();
    await settle(() => expect(q("p-adjust")).not.toBeNull());
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
    const other: OtherProfile = { current: vi.fn(async () => OTHER_URL), apply: vi.fn(async () => true), copy };
    dom.fingerprints.set(OTHER_URL, Array.from({ length: 256 }, () => 220));
    render({ other });

    await pick();
    await settle(() => expect(q("p-offer-text")?.textContent).toBe(copy.diffText));
    expect(q("p-offer-action")?.textContent?.trim()).toBe(copy.diffAction);
  });

  it("stays quiet when the other profile already has the same photo", async () => {
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
