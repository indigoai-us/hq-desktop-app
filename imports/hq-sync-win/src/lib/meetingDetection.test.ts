import { describe, it, expect } from "vitest";
import { isSyntheticUrl, notifyArgsFor } from "./meetingDetection";

describe("isSyntheticUrl", () => {
  it("flags the recall-window placeholder", () => {
    expect(isSyntheticUrl("recall-window:43F5EBF4-8949")).toBe(true);
  });

  it("does not flag real join URLs", () => {
    expect(isSyntheticUrl("https://zoom.us/j/123")).toBe(false);
    expect(isSyntheticUrl("https://meet.google.com/abc-defg-hij")).toBe(false);
  });

  it("handles undefined / null / empty", () => {
    expect(isSyntheticUrl(undefined)).toBe(false);
    expect(isSyntheticUrl(null)).toBe(false);
    expect(isSyntheticUrl("")).toBe(false);
  });
});

describe("notifyArgsFor", () => {
  it("passes through a fully-populated payload", () => {
    expect(
      notifyArgsFor({
        meetingUrl: "https://zoom.us/j/9",
        windowId: "win-7",
        platform: "zoom",
        summary: "Sync",
        sourceEventId: "evt-9",
      }),
    ).toEqual({
      meetingUrl: "https://zoom.us/j/9",
      windowId: "win-7",
      platform: "zoom",
      summary: "Sync",
      sourceEventId: "evt-9",
    });
  });

  it("normalises empty / whitespace-only fields to null", () => {
    // The Rust stable-key derivation must not treat "" as a real key.
    expect(
      notifyArgsFor({
        meetingUrl: "",
        windowId: "   ",
        platform: undefined,
        summary: "",
        sourceEventId: undefined,
      }),
    ).toEqual({
      meetingUrl: null,
      windowId: null,
      platform: null,
      summary: null,
      sourceEventId: null,
    });
  });

  it("trims surrounding whitespace on real values", () => {
    expect(notifyArgsFor({ windowId: "  win-7  ", platform: " zoom " })).toEqual({
      meetingUrl: null,
      windowId: "win-7",
      platform: "zoom",
      summary: null,
      sourceEventId: null,
    });
  });

  it("keeps a synthetic URL as a value (caller decides how to treat it)", () => {
    const args = notifyArgsFor({ meetingUrl: "recall-window:abc", windowId: "abc" });
    expect(args.meetingUrl).toBe("recall-window:abc");
    expect(isSyntheticUrl(args.meetingUrl)).toBe(true);
  });
});
