// @vitest-environment happy-dom
/**
 * Download a badge card for social (owner request 2026-10-08): an image or a
 * short video, square / story / landscape, from the card stage.
 */
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadShare = vi.fn(async () => {});
vi.mock("./badge-share.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./badge-share.js")>();
  return { ...real, downloadShare: (...args: unknown[]) => downloadShare(...(args as [])), canRecordVideo: () => true };
});

import BadgeCardModal from "./BadgeCardModal.svelte";
import { BADGE_BY_ID, type ResolvedBadge } from "./badge-catalog.js";
import { SHARE_SIZE, ShareError, balancedLines, groupShift, stackShift, pickVideoType, recordedVideo, ruleXs, shareCode, shareFileName, shareLayout, shareLogoBox, SHARE_SIDE_LABEL, SHARE_TAG, videoFrame, wrapLines, SHARE_VIDEO_MS } from "./badge-share.js";
import { badgeStory } from "./badge-story.js";

const liftoff: ResolvedBadge = { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" };
const mounted: Array<ReturnType<typeof mount>> = [];
let host: HTMLElement;

beforeEach(() => {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  host = document.createElement("div");
  document.body.appendChild(host);
  downloadShare.mockReset();
  downloadShare.mockResolvedValue(undefined);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

describe("share files", () => {
  it("comes in square, story and landscape at social sizes", () => {
    expect(SHARE_SIZE.square).toMatchObject({ w: 1080, h: 1080, ratio: "1:1" });
    expect(SHARE_SIZE.story).toMatchObject({ w: 1080, h: 1920, ratio: "9:16" });
    expect(SHARE_SIZE.landscape).toMatchObject({ w: 1920, h: 1080, ratio: "16:9" });
  });

  it.each(["square", "story", "landscape"] as const)("%s sets the card and words inside the technical grid", (shape) => {
    const { w, h } = SHARE_SIZE[shape];
    const L = shareLayout(shape);
    const [, innerL, innerR] = L.grid.xs;
    const [top, bottom] = L.grid.ys;
    // One rule a side (the outer one), symmetric; the dashed rules inside the frame.
    expect(ruleXs(L.grid)).toEqual([L.grid.xs[0], L.grid.xs[3]]);
    expect(L.grid.xs[0]).toBeCloseTo(w - L.grid.xs[3]);
    expect(innerL).toBeCloseTo(w - innerR);
    expect(top).toBeGreaterThan(0);
    expect(bottom).toBeLessThan(h);
    for (const box of [L.card, L.text]) {
      expect(box.x).toBeGreaterThanOrEqual(innerL);
      expect(box.x + box.w).toBeLessThanOrEqual(innerR);
      expect(box.y).toBeGreaterThanOrEqual(top);
    }
    expect(L.card.y + L.card.h).toBeLessThanOrEqual(bottom);
    // The card keeps its 5:7 proportions.
    expect(L.card.h / L.card.w).toBeCloseTo(1.4);
    // The words never sit on the card: under it, centred, in story and square; beside it in landscape.
    expect(L.stacked).toBe(shape !== "landscape");
    if (L.stacked) {
      expect(L.text.y).toBeGreaterThan(L.card.y + L.card.h);
      expect(L.card.x + L.card.w / 2).toBeCloseTo(w / 2);
      expect(L.text.x + L.text.w / 2).toBeCloseTo(w / 2);
    } else expect(L.text.x).toBeGreaterThan(L.card.x + L.card.w);
    // Square and landscape: the same gutter top, bottom and sides.
    if (shape !== "story") {
      expect(L.grid.ys[0]).toBeCloseTo(L.grid.xs[0]);
      expect(h - L.grid.ys[1]).toBeCloseTo(L.grid.xs[0]);
    }
    // Story keeps the grid clear of the reply bar at the bottom.
    if (shape === "story") expect(bottom).toBeLessThanOrEqual(h - 300);
  });

  it("labels the card like the gallery's share card", () => {
    expect(shareCode(liftoff)).toBe("HQ-B-004 · T-II");
    // The tag on the bottom rule is where to find HQ; the left rule names what this is.
    expect(SHARE_TAG).toBe("HQFORWORK.COM");
    expect(SHARE_SIDE_LABEL).toBe("HQ ACCOMPLISHMENT BADGE");
    // The HQ mark sits on the top rule at the left, diagonally across from the tag on the bottom rule at the right.
    for (const shape of ["square", "story", "landscape"] as const) {
      const L = shareLayout(shape);
      const logo = shareLogoBox(L.grid);
      expect(logo.y + logo.h / 2).toBeCloseTo(L.grid.ys[0]);
      expect(logo.x - L.grid.xs[1]).toBeCloseTo(20 * L.grid.k);
    }
  });

  it("centres the card and a short story as one group between the inner rules", () => {
    // Stacked layouts centre the card and words between the rules, keeping clear of the top rule.
    for (const shape of ["story", "square"] as const) {
      const L = shareLayout(shape);
      const copy = 200;
      const dy = stackShift(shape, copy);
      const above = L.card.y + dy - L.grid.ys[0];
      const below = L.grid.ys[1] - (L.text.y + dy + copy);
      expect(above).toBeCloseTo(below, 0);
      expect(L.card.y + stackShift(shape, 5000)).toBeCloseTo(L.grid.ys[0] + 50 * L.grid.k);
    }
    expect(stackShift("landscape", 200)).toBe(0);
    expect(groupShift("story", 300)).toBe(0);
    expect(groupShift("square", 300)).toBe(0);
    for (const shape of ["landscape"] as const) {
      const L = shareLayout(shape);
      const [, innerL, innerR] = L.grid.xs;
      const copy = L.text.w / 2;
      const dx = groupShift(shape, copy);
      expect(dx).toBeGreaterThan(0);
      const left = L.card.x + dx - innerL;
      const right = innerR - (L.text.x + dx + copy);
      expect(left).toBeCloseTo(right, 0);
      // A full-width story leaves the group where it is.
      expect(groupShift(shape, L.text.w)).toBeLessThanOrEqual(L.text.x + L.text.w <= innerR ? innerR - (L.text.x + L.text.w) : 0);
    }
  });

  it("never hands over an empty video", () => {
    expect(() => recordedVideo([], "video/mp4;codecs=avc1")).toThrow(ShareError);
    const video = recordedVideo([new Blob(["x"])], "video/mp4;codecs=avc1");
    expect(video.type).toBe("video/mp4");
    expect(video.size).toBe(1);
  });

  it("names the file for the badge, level and size", () => {
    expect(shareFileName(liftoff, "story", "png")).toBe("hq-badge-liftoff-silver-story.png");
    expect(shareFileName({ ...liftoff, def: BADGE_BY_ID.founding, tier: "L" }, "landscape", "mp4")).toBe("hq-badge-founding-legendary-landscape.mp4");
  });

  it("records MP4 where the window can, WebM otherwise, and says so when neither", () => {
    expect(pickVideoType((t) => t.startsWith("video/mp4"))).toEqual({ mime: "video/mp4;codecs=avc1", ext: "mp4" });
    expect(pickVideoType((t) => t === "video/webm")).toEqual({ mime: "video/webm", ext: "webm" });
    expect(pickVideoType(() => false)).toBeNull();
  });

  it("turns the card over from its back, then tilts it under a moving light on the foil, then settles", () => {
    const start = videoFrame(0);
    expect(start.rotY).toBeCloseTo(Math.PI);
    expect(start).toMatchObject({ glow: 0, words: 0 });
    // Mid-turn: edge-on, with light crossing the foil.
    const mid = videoFrame(600 + 650);
    expect(Math.abs(Math.cos(mid.rotY))).toBeLessThan(0.2);
    expect(mid.light.hover).toBeGreaterThan(0.5);
    // Hover: the light moves and the card tilts toward it, gently.
    const hovers = [3000, 3600, 4200, 5000].map(videoFrame);
    for (const f of hovers) {
      expect(f.light.hover).toBe(1);
      expect(Math.abs(f.rotY)).toBeLessThanOrEqual(0.22);
      expect(Math.abs(f.rotX)).toBeLessThanOrEqual(0.16);
      expect(Math.sign(f.rotY)).toBe(Math.sign(f.light.x));
      expect(f.words).toBe(1);
    }
    expect(new Set(hovers.map((f) => f.light.x.toFixed(2))).size).toBe(4);
    // The end: flat, light gone, words up.
    const end = videoFrame(SHARE_VIDEO_MS);
    expect(end).toMatchObject({ glow: 1, rotY: 0, words: 1 });
    expect(Math.abs(end.rotX)).toBe(0);
    expect(end.light.hover).toBe(0);
  });

  it("wraps the story to the column and ends a cut line with an ellipsis", () => {
    const measure = (s: string) => s.length * 10;
    expect(wrapLines(measure, "one two three four", 100)).toEqual(["one two", "three four"]);
    expect(wrapLines(measure, "a b c d e f", 30, 2)).toEqual(["a b", "c d…"]);
  });

  it("never leaves one word alone on the last line", () => {
    const measure = (s: string) => s.length * 10;
    const text = "work people can use, not work waiting on a branch.";
    expect(wrapLines(measure, text, 420).at(-1)).toBe("branch.");
    const even = balancedLines(measure, text, 420);
    expect(even).toHaveLength(2);
    expect(even.at(-1)!.split(" ").length).toBeGreaterThan(1);
  });

  it("posts your own card in your voice, and someone else's about them", () => {
    expect(badgeStory(liftoff, null, "first")?.did).toBe("I put 50 deploys live.");
    expect(badgeStory({ ...liftoff, def: BADGE_BY_ID.founder, tier: 3 }, null, "first")?.why).toMatch(/started with me\.$/u);
    expect(badgeStory(liftoff, "Maya Chen", "third")?.did).toBe("Maya put 50 deploys live.");
  });
});

describe("Download on the card stage", () => {
  const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement;
  const q = <T extends HTMLElement>(id: string) => modal().querySelector(`[data-testid="${id}"]`) as T | null;

  it("picks image or video and a size, then downloads it", async () => {
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, owner: "Maya Chen", onclose: () => {} } }));
    flushSync();
    expect(q("badge-share-menu")).toBeNull();
    q<HTMLButtonElement>("badge-card-share")!.click();
    flushSync();
    expect(q("badge-card-share")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("badge-share-kind-image")!.getAttribute("aria-checked")).toBe("true");
    expect(q("badge-share-shape-square")!.getAttribute("aria-checked")).toBe("true");
    expect(q("badge-share-download")!.textContent?.trim()).toBe("Download image");

    q<HTMLButtonElement>("badge-share-kind-video")!.click();
    q<HTMLButtonElement>("badge-share-shape-story")!.click();
    flushSync();
    expect(q("badge-share-shape-story")!.getAttribute("aria-checked")).toBe("true");
    q<HTMLButtonElement>("badge-share-download")!.click();
    await tick();
    await Promise.resolve();
    flushSync();
    expect(downloadShare).toHaveBeenCalledWith(liftoff, "video", "story", "Maya Chen");
    expect(q("badge-share-menu")).toBeNull();
  });

  it("asks you to keep the window open while a video records", async () => {
    let finish: () => void = () => {};
    downloadShare.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, onclose: () => {} } }));
    flushSync();
    q<HTMLButtonElement>("badge-card-share")!.click();
    flushSync();
    q<HTMLButtonElement>("badge-share-kind-video")!.click();
    flushSync();
    q<HTMLButtonElement>("badge-share-download")!.click();
    flushSync();
    expect(q("badge-share-download")!.textContent?.trim()).toBe("Recording video…");
    expect(q("badge-share-recording")?.textContent).toBe("Takes about 7 seconds. Keep this window open.");
    finish();
    for (let i = 0; i < 4; i += 1) await tick();
    flushSync();
    expect(q("badge-share-menu")).toBeNull();
  });

  it("shows plain words when a file can't be made", async () => {
    downloadShare.mockRejectedValueOnce(new ShareError("Video isn't available in this window. Try the image."));
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, onclose: () => {} } }));
    flushSync();
    q<HTMLButtonElement>("badge-card-share")!.click();
    flushSync();
    q<HTMLButtonElement>("badge-share-download")!.click();
    for (let i = 0; i < 4; i += 1) await tick();
    flushSync();
    expect(q("badge-share-error")?.textContent).toBe("Video isn't available in this window. Try the image.");
  });

  it("Escape closes the menu first, then the stage", () => {
    const onclose = vi.fn();
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, onclose } }));
    flushSync();
    q<HTMLButtonElement>("badge-card-share")!.click();
    flushSync();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(q("badge-share-menu")).toBeNull();
    expect(onclose).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("waits for the reveal like Flip card", () => {
    vi.useFakeTimers();
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: liftoff, reveal: true, onclose: () => {} } }));
    flushSync();
    expect(q<HTMLButtonElement>("badge-card-share")!.disabled).toBe(true);
    vi.useRealTimers();
  });
});
