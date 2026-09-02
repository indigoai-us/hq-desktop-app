import { describe, expect, it } from "vitest";
import {
  MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX,
  TITLEBAR_HEIGHT_PX,
  TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX,
  TITLEBAR_TRAFFIC_LIGHT_X_PX,
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
  });
});
