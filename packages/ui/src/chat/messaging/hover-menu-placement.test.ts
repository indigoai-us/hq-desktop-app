import { describe, expect, it } from "vitest";

import {
  HOVER_MENU_GAP_PX,
  hoverMenuClippedBelow,
} from "./hover-menu-placement";

describe("hoverMenuClippedBelow", () => {
  it("opens 4px under the message", () => {
    expect(HOVER_MENU_GAP_PX).toBe(4);
  });

  it("is clipped when the menu would end below the scrollport", () => {
    // Menu bottom = 100 + 4 + 40 = 144. Scrollport ends at 140.
    expect(hoverMenuClippedBelow(100, 40, 140)).toBe(true);
  });

  it("fits when the hanging menu is inside the scrollport", () => {
    expect(hoverMenuClippedBelow(100, 40, 200)).toBe(false);
  });

  it("treats half a pixel of overrun as inside", () => {
    expect(hoverMenuClippedBelow(100, 40, 143.5)).toBe(false);
    expect(hoverMenuClippedBelow(100, 40, 143.4)).toBe(true);
  });
});
