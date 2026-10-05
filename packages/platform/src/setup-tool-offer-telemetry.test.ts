import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchSetupToolOffer,
  SETUP_TOOL_OFFER_EVENT,
  SETUP_TOOL_OFFER_EVENTS,
  setupToolOfferTelemetry,
} from "./setup-tool-offer-telemetry.js";

describe("setup tool offer telemetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names one event per action: shown, continued in the tool, kept here", () => {
    expect(SETUP_TOOL_OFFER_EVENTS).toEqual({
      shown: "setup_tool_offer_shown",
      continued: "setup_tool_offer_continued",
      keptHere: "setup_tool_offer_kept_here",
    });
  });

  it("carries the tool's id and a launched flag only", () => {
    expect(setupToolOfferTelemetry({ action: "shown", tool: "claude" })).toEqual({
      eventName: "setup_tool_offer_shown",
      properties: { tool: "claude" },
    });
    expect(setupToolOfferTelemetry({ action: "continued", tool: "codex", launched: true })).toEqual({
      eventName: "setup_tool_offer_continued",
      properties: { tool: "codex", launched: true },
    });
    expect(
      setupToolOfferTelemetry({ action: "keptHere", tool: "claude", launched: true, path: "/Users/x/HQ", prompt: "secret" }),
    ).toEqual({ eventName: "setup_tool_offer_kept_here", properties: { tool: "claude" } });
  });

  it("drops anything malformed", () => {
    for (const detail of [null, "shown", {}, { action: "clicked", tool: "claude" }, { action: "shown", tool: "cursor" }]) {
      expect(setupToolOfferTelemetry(detail)).toBeNull();
    }
  });

  it("dispatches a window event the shell forwards", () => {
    const dispatchEvent = vi.fn();
    class FakeCustomEvent {
      constructor(public type: string, public init: { detail: unknown }) {}
    }
    vi.stubGlobal("window", { dispatchEvent });
    vi.stubGlobal("CustomEvent", FakeCustomEvent);
    dispatchSetupToolOffer("continued", "claude", { launched: false });
    const event = dispatchEvent.mock.calls[0]![0] as FakeCustomEvent;
    expect(event.type).toBe(SETUP_TOOL_OFFER_EVENT);
    expect(event.init.detail).toEqual({ action: "continued", tool: "claude", launched: false });
  });
});
