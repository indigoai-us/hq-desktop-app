import { describe, expect, it } from "vitest";
import {
  EMPTY_ROW_STATE,
  parseRedactionSettings,
  viewerCanEditRedaction,
  withFailed,
  withSaved,
  withToggle,
  type RedactionRowState,
} from "./redaction-presets";

const LOADED: RedactionRowState = {
  settings: {
    presets: [
      { id: "emails", label: "Email addresses", enabled: true },
      { id: "phone_numbers", label: "Phone numbers", enabled: false },
    ],
  },
  pending: new Set(),
  error: null,
};

describe("US-005 redaction presets model", () => {
  it("parses presets, keeps server labels and fills known ids", () => {
    const parsed = parseRedactionSettings({
      presets: [
        { id: "emails", label: "Emails", enabled: true },
        { id: "payment_cards", enabled: false },
        { id: "custom_x", enabled: true },
        { id: "emails", label: "dup", enabled: false },
        { id: "", enabled: true },
        { id: "no_flag" },
        null,
      ],
    });
    expect(parsed.presets).toEqual([
      { id: "emails", label: "Emails", enabled: true },
      { id: "payment_cards", label: "Payment card numbers", enabled: false },
      { id: "custom_x", label: "custom_x", enabled: true },
    ]);
  });

  it("rejects an answer without a presets list", () => {
    expect(() => parseRedactionSettings({})).toThrow();
    expect(() => parseRedactionSettings(null)).toThrow();
  });

  it("lets owners and admins edit and keeps members read-only", () => {
    expect(viewerCanEditRedaction({ viewer: { role: "owner" } })).toBe(true);
    expect(viewerCanEditRedaction({ viewer: { role: "admin", canManageIntegrations: false } })).toBe(true);
    expect(viewerCanEditRedaction({ viewer: { role: "member", canManageIntegrations: true } })).toBe(false);
    expect(viewerCanEditRedaction({ viewer: { canManageIntegrations: true } })).toBe(true);
    expect(viewerCanEditRedaction({ viewer: {} })).toBe(false);
    expect(viewerCanEditRedaction(null)).toBe(false);
  });

  it("shows the requested value as pending at once", () => {
    const next = withToggle(LOADED, "phone_numbers", true);
    expect(next.pending.has("phone_numbers")).toBe(true);
    expect(next.settings?.presets[1]?.enabled).toBe(true);
    expect(LOADED.pending.size).toBe(0);
    expect(withToggle(EMPTY_ROW_STATE, "emails", false)).toBe(EMPTY_ROW_STATE);
  });

  it("takes the server value when the save finishes", () => {
    const pending = withToggle(LOADED, "phone_numbers", true);
    const saved = withSaved(pending, "phone_numbers", {
      presets: [{ id: "phone_numbers", label: "Phone numbers", enabled: false }],
    });
    expect(saved.pending.size).toBe(0);
    expect(saved.settings?.presets[1]?.enabled).toBe(false);
    expect(saved.settings?.presets[0]?.enabled).toBe(true);
  });

  it("puts the old value back and says so when the save fails", () => {
    const pending = withToggle(LOADED, "emails", false);
    const failed = withFailed(pending, "emails", true);
    expect(failed.pending.size).toBe(0);
    expect(failed.settings?.presets[0]?.enabled).toBe(true);
    expect(failed.error).toBe("Couldn't save that change. Try again.");
  });
});
