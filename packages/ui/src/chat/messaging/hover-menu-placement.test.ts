import { describe, expect, it } from "vitest";

import {
  HOVER_MENU_OVERLAP_PX,
  hoverMenuClippedAbove,
} from "./hover-menu-placement";

describe("hoverMenuClippedAbove", () => {
  it("overlaps the row by 3px", () => {
    expect(HOVER_MENU_OVERLAP_PX).toBe(3);
  });

  it("is clipped when the menu would start above the scrollport", () => {
    // Menu top = 100 - (40 - 3) = 63. Scrollport at 70.
    expect(hoverMenuClippedAbove(100, 40, 70)).toBe(true);
  });

  it("fits when the protruding menu is inside the scrollport", () => {
    // Menu top = 63. Scrollport at 50.
    expect(hoverMenuClippedAbove(100, 40, 50)).toBe(false);
  });

  it("treats half a pixel of clearance as inside", () => {
    // 63 < 63.5 - 0.5 is false; 63 < 63.6 - 0.5 is true.
    expect(hoverMenuClippedAbove(100, 40, 63.5)).toBe(false);
    expect(hoverMenuClippedAbove(100, 40, 63.6)).toBe(true);
  });
});
