import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CENTER_CROP,
  base64ToBytes,
  clampCrop,
  cropRect,
  cropView,
  fingerprintDistance,
  panCrop,
  sameFingerprint,
} from "./profile-photo.js";

describe("profile photo crop math", () => {
  it("centers a square on the shorter side by default", () => {
    expect(cropRect(800, 600, CENTER_CROP)).toEqual({ sx: 100, sy: 0, side: 600 });
    expect(cropRect(600, 800, CENTER_CROP)).toEqual({ sx: 0, sy: 100, side: 600 });
  });

  it("zooming shrinks the square around its center", () => {
    expect(cropRect(800, 600, { x: 0, y: 0, zoom: 2 })).toEqual({ sx: 250, sy: 150, side: 300 });
  });

  it("keeps zoom between 1 and 3 and the square inside the image", () => {
    expect(clampCrop(800, 600, { x: 0, y: 0, zoom: 9 }).zoom).toBe(3);
    expect(clampCrop(800, 600, { x: 0, y: 0, zoom: 0.2 }).zoom).toBe(1);
    // At zoom 1 a landscape photo can only slide sideways, by 100px of 600.
    const c = clampCrop(800, 600, { x: 5, y: 5, zoom: 1 });
    expect(c.x).toBeCloseTo(100 / 600);
    expect(c.y).toBe(0);
    const rect = cropRect(800, 600, { x: 5, y: -5, zoom: 1 });
    expect(rect.sx + rect.side).toBeCloseTo(800);
  });

  it("treats non-finite input as centered", () => {
    expect(clampCrop(800, 600, { x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: Number.NaN })).toEqual(
      CENTER_CROP,
    );
    expect(clampCrop(0, 0, { x: 1, y: 1, zoom: 2 })).toEqual(CENTER_CROP);
  });

  it("dragging right moves the photo right, so the crop moves left", () => {
    const source = { width: 800, height: 600 };
    const moved = panCrop(source, CENTER_CROP, 24, 0, 144);
    expect(moved.x).toBeLessThan(0);
    // 24px of a 144px window over a 600px square is 100 source px.
    expect(cropRect(800, 600, moved).sx).toBeCloseTo(0);
  });

  it("maps a crop to the image size and offset shown through a window", () => {
    const view = cropView({ width: 800, height: 600 }, CENTER_CROP, 144);
    expect(view.width).toBeCloseTo(192);
    expect(view.height).toBeCloseTo(144);
    expect(view.dx).toBeCloseTo(0);
    expect(view.dy).toBeCloseTo(0);
    const left = cropView({ width: 800, height: 600 }, { x: -1, y: 0, zoom: 1 }, 144);
    expect(left.dx).toBeCloseTo(24);
  });
});

describe("photo fingerprints", () => {
  it("treats small re-encoding noise as the same photo", () => {
    const a = Array.from({ length: 256 }, (_, i) => i % 255);
    const noisy = a.map((v, i) => v + (i % 2 === 0 ? 4 : -4));
    expect(sameFingerprint(a, noisy)).toBe(true);
  });

  it("treats different pictures as different", () => {
    const a = Array.from({ length: 256 }, () => 40);
    const b = Array.from({ length: 256 }, () => 200);
    expect(sameFingerprint(a, b)).toBe(false);
    expect(fingerprintDistance(a, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("base64ToBytes", () => {
  it("decodes raw base64", () => {
    expect(Array.from(base64ToBytes("/9j/"))).toEqual([0xff, 0xd8, 0xff]);
  });
});

describe("loadPhotoSource", () => {
  const SAVED =
    "https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/p/a.jpg?X-Amz-Signature=1";

  class FakeImage {
    naturalWidth = 640;
    naturalHeight = 480;
    width = 640;
    height = 480;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  class FakeReader {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then((buf) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buf).toString("base64")}`;
        this.onload?.();
      });
    }
  }

  function stubDom() {
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("FileReader", FakeReader);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads a saved photo from its https URL into a local data: URL", async () => {
    stubDom();
    const { loadPhotoSource } = await import("./profile-photo.js");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" })));

    const source = await loadPhotoSource(SAVED);

    expect(fetchSpy).toHaveBeenCalledWith(SAVED, { mode: "cors", credentials: "omit", cache: "no-store" });
    expect(source).toEqual({ url: "data:image/jpeg;base64,/9j/", width: 640, height: 480 });
  });

  it("turns a blocked or failed download into app-written copy", async () => {
    stubDom();
    const { loadPhotoSource, PhotoError } = await import("./profile-photo.js");
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("Load failed"));
    const blocked = loadPhotoSource(SAVED);
    await expect(blocked).rejects.toBeInstanceOf(PhotoError);
    await expect(blocked).rejects.toThrow("Couldn't load this photo. Pick it again to edit it.");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("expired", { status: 403 }));
    await expect(loadPhotoSource(SAVED)).rejects.toThrow("Couldn't load this photo. Pick it again to edit it.");
  });

  it("refuses a download that isn't an image", async () => {
    stubDom();
    const { loadPhotoSource, PhotoError } = await import("./profile-photo.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(new Blob(["<html>"], { type: "text/html" })));
    await expect(loadPhotoSource(SAVED)).rejects.toBeInstanceOf(PhotoError);
  });

  it("never fetches a non-https URL", async () => {
    const { loadPhotoSource, PhotoError } = await import("./profile-photo.js");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(loadPhotoSource("http://example.com/a.jpg")).rejects.toBeInstanceOf(PhotoError);
    await expect(loadPhotoSource("asset://localhost/a.jpg")).rejects.toBeInstanceOf(PhotoError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
