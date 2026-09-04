import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX,
  TITLEBAR_HEIGHT_CSS_VAR,
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_LEADING_INSET_CSS_VAR,
  TITLEBAR_NO_WINDOW_CONTROLS_LEADING_INSET_PX,
  TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX,
  TITLEBAR_TRAFFIC_LIGHT_X_PX,
  TITLEBAR_WINDOWS_LEADING_INSET_PX,
  titlebarContentCenterPx,
  trafficLightPosition,
  trafficLightYPx,
} from "./titlebar-layout.js";

describe("titlebar layout — traffic-light centre line", () => {
  it("places the traffic-light centre on the titlebar content centre", () => {
    expect(TITLEBAR_HEIGHT_PX).toBe(48);
    expect(titlebarContentCenterPx()).toBe(24);
    expect(trafficLightYPx()).toBe(24);
    expect(trafficLightPosition()).toEqual({ x: 20, y: 24 });
  });

  it("follows the titlebar height so a taller bar keeps the lights centred", () => {
    expect(trafficLightYPx(56)).toBe(28);
    expect(trafficLightYPx(40)).toBe(20);
    expect(titlebarContentCenterPx(56)).toBe(trafficLightYPx(56));
  });

  it("keeps the macOS gutter and leading inset that the titlebar CSS reserves", () => {
    expect(TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX).toBe(78);
    expect(TITLEBAR_TRAFFIC_LIGHT_X_PX).toBe(20);
    expect(MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX).toBe(14);
    expect(TITLEBAR_WINDOWS_LEADING_INSET_PX).toBe(12);
    expect(TITLEBAR_NO_WINDOW_CONTROLS_LEADING_INSET_PX).toBe(16);
  });
});

describe("titlebar layout — CSS variables stay in lockstep with the constants", () => {
  const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

  it("publishes the shared CSS custom property names", () => {
    expect(TITLEBAR_HEIGHT_CSS_VAR).toBe("--titlebar-height");
    expect(TITLEBAR_LEADING_INSET_CSS_VAR).toBe("--titlebar-leading-inset");
  });

  it("defines --titlebar-height and --titlebar-leading-inset from the same numbers", () => {
    expect(tokens).toContain(
      `${TITLEBAR_HEIGHT_CSS_VAR}: ${TITLEBAR_HEIGHT_PX}px`,
    );
    expect(tokens).toContain(
      `${TITLEBAR_LEADING_INSET_CSS_VAR}: ${TITLEBAR_NO_WINDOW_CONTROLS_LEADING_INSET_PX}px`,
    );
    expect(tokens).toMatch(
      new RegExp(
        `\\.has-window-controls\\s*\\{[\\s\\S]*?${TITLEBAR_LEADING_INSET_CSS_VAR}:\\s*${TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX}px`,
      ),
    );
    expect(tokens).toMatch(
      new RegExp(
        `html\\[data-platform=["']windows["']\\]\\s*\\{[\\s\\S]*?${TITLEBAR_LEADING_INSET_CSS_VAR}:\\s*${TITLEBAR_WINDOWS_LEADING_INSET_PX}px`,
      ),
    );
  });
});
