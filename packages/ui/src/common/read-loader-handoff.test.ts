import { beforeEach, describe, expect, it } from "vitest";
import { HANDOFF_MS, beginLoaderWait, endLoaderWait, resetLoaderWaits } from "./read-loader-handoff.js";

beforeEach(() => resetLoaderWaits());

describe("read loader handoff", () => {
  it("a fresh loader starts a new wait", () => {
    expect(beginLoaderWait(1_000)).toBe(1_000);
  });

  it("a loader replacing another within the handoff window keeps the first start", () => {
    beginLoaderWait(1_000);
    endLoaderWait(2_500);
    expect(beginLoaderWait(2_500 + HANDOFF_MS)).toBe(1_000);
  });

  it("a loader mounting while another is showing keeps the first start", () => {
    beginLoaderWait(1_000);
    expect(beginLoaderWait(1_800)).toBe(1_000);
  });

  it("a loader after the handoff window starts a new wait", () => {
    beginLoaderWait(1_000);
    endLoaderWait(2_000);
    expect(beginLoaderWait(2_000 + HANDOFF_MS + 1)).toBe(2_000 + HANDOFF_MS + 1);
  });
});
