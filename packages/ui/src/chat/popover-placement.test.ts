import { describe, expect, it } from "vitest";

import {
  FILTER_POPOVER_MAX_PX,
  FILTER_POPOVER_RAIL_OVERHANG_PX,
  VIEWPORT_MARGIN_PX,
  clampPopoverWidth,
  placeAnchoredPopover,
  type AnchorRect,
} from "./popover-placement.js";

function button(left: number, width = 28, top = 8, height = 28): AnchorRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

describe("clampPopoverWidth", () => {
  it("clamps to min(360, window − 16px) on a narrow window", () => {
    expect(
      clampPopoverWidth({
        preferred: 490,
        viewportWidth: 300,
        maxWidth: FILTER_POPOVER_MAX_PX,
      }),
    ).toBe(300 - VIEWPORT_MARGIN_PX * 2);
  });

  it("never exceeds the rail width plus 40px", () => {
    expect(
      clampPopoverWidth({
        preferred: 490,
        viewportWidth: 1000,
        maxWidth: FILTER_POPOVER_MAX_PX,
        railWidth: 200,
        railOverhang: FILTER_POPOVER_RAIL_OVERHANG_PX,
      }),
    ).toBe(240);
  });
});

describe("placeAnchoredPopover", () => {
  it("shifts a bottom-end popover to x ≥ 8 when the button is near the left edge", () => {
    const placed = placeAnchoredPopover({
      anchor: button(4),
      viewport: { width: 1000, height: 800 },
      placement: "bottom-end",
      popoverWidth: 360,
      maxWidth: FILTER_POPOVER_MAX_PX,
    });
    expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    expect(placed.left).toBe(VIEWPORT_MARGIN_PX);
    expect(placed.width).toBe(360);
    expect(placed.left + placed.width).toBeLessThanOrEqual(1000 - VIEWPORT_MARGIN_PX);
  });

  it("right-aligns to the button when it sits near the right edge", () => {
    const anchor = button(960);
    const placed = placeAnchoredPopover({
      anchor,
      viewport: { width: 1000, height: 800 },
      placement: "bottom-end",
      popoverWidth: 200,
    });
    expect(placed.width).toBe(200);
    expect(placed.left + placed.width).toBe(anchor.right);
    expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
  });

  it("clamps width on a narrow window", () => {
    const placed = placeAnchoredPopover({
      anchor: button(40),
      viewport: { width: 280, height: 600 },
      placement: "bottom-end",
      popoverWidth: 490,
      maxWidth: FILTER_POPOVER_MAX_PX,
    });
    expect(placed.width).toBe(280 - VIEWPORT_MARGIN_PX * 2);
    expect(placed.left).toBe(VIEWPORT_MARGIN_PX);
    expect(placed.left + placed.width).toBeLessThanOrEqual(280 - VIEWPORT_MARGIN_PX);
  });

  it("keeps a 490px-content filter popover inside a 1000px window over a 320px sidebar", () => {
    const railWidth = 320;
    const anchor = button(railWidth - 28);
    const placed = placeAnchoredPopover({
      anchor,
      viewport: { width: 1000, height: 800 },
      placement: "bottom-end",
      popoverWidth: 490,
      popoverHeight: 240,
      maxWidth: FILTER_POPOVER_MAX_PX,
      railWidth,
      railOverhang: FILTER_POPOVER_RAIL_OVERHANG_PX,
    });
    expect(placed.width).toBe(
      Math.min(
        FILTER_POPOVER_MAX_PX,
        1000 - VIEWPORT_MARGIN_PX * 2,
        railWidth + FILTER_POPOVER_RAIL_OVERHANG_PX,
      ),
    );
    expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN_PX);
    expect(placed.left + placed.width).toBeLessThanOrEqual(
      1000 - VIEWPORT_MARGIN_PX,
    );
    expect(placed.top).toBe(anchor.bottom + 4);
  });
});
