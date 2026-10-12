import { describe, expect, it } from "vitest";
import {
  EMPTY_ROW_STATE,
  REDACTION_PRESETS,
  defaultRedactionSettings,
  parseRedactionSettings,
  viewerCanEditRedaction,
  withFailed,
  withSaved,
  withToggle,
  type RedactionRowState,
} from "./redaction-presets";

const LOADED: RedactionRowState = {
  settings: parseRedactionSettings({ presets: [{ id: "legal", enabled: false }] }),
  pending: new Set(),
  error: null,
};

describe("US-005 redaction presets model", () => {
  it("uses the four hq-pro #4910 presets in order", () => {
    expect(REDACTION_PRESETS.map((p) => [p.id, p.label])).toEqual([
      ["personal-ids", "Personal IDs"],
      ["hr-pay", "Salary and HR"],
      ["legal", "Legal matters"],
      ["financial", "Bank and card numbers"],
    ]);
  });

  it("turns all four on when the connection has no setting", () => {
    const allOn = defaultRedactionSettings().presets.map((p) => p.enabled);
    expect(allOn).toEqual([true, true, true, true]);
    expect(parseRedactionSettings({}).presets.map((p) => p.enabled)).toEqual(allOn);
    expect(parseRedactionSettings(null).presets.map((p) => p.enabled)).toEqual(allOn);
    expect(parseRedactionSettings({ presets: [] }).presets.map((p) => p.enabled)).toEqual(allOn);
  });

  it("reads list and map answers, keeps local labels, ignores unknown ids", () => {
    const fromList = parseRedactionSettings({
      presets: [
        { id: "legal", label: "server label", enabled: false },
        { id: "hr-pay", enabled: false },
        { id: "emails", enabled: false },
        { id: "legal", enabled: true },
        { id: "financial", enabled: "no" },
        null,
      ],
    });
    expect(fromList.presets).toEqual([
      { id: "personal-ids", label: "Personal IDs", enabled: true },
      { id: "hr-pay", label: "Salary and HR", enabled: false },
      { id: "legal", label: "Legal matters", enabled: false },
      { id: "financial", label: "Bank and card numbers", enabled: true },
    ]);
    const fromMap = parseRedactionSettings({ presets: { legal: false, financial: false, other: false } });
    expect(fromMap.presets.map((p) => p.enabled)).toEqual([true, true, false, false]);
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
    const next = withToggle(LOADED, "financial", false);
    expect(next.pending.has("financial")).toBe(true);
    expect(next.settings?.presets[3]?.enabled).toBe(false);
    expect(LOADED.pending.size).toBe(0);
    expect(withToggle(EMPTY_ROW_STATE, "legal", false)).toBe(EMPTY_ROW_STATE);
  });

  it("takes the server value when the save finishes", () => {
    const pending = withToggle(LOADED, "legal", true);
    const saved = withSaved(pending, "legal", parseRedactionSettings({ presets: [{ id: "legal", enabled: false }] }));
    expect(saved.pending.size).toBe(0);
    expect(saved.settings?.presets[2]?.enabled).toBe(false);
  });

  it("puts the old value back and says so when the save fails", () => {
    const pending = withToggle(LOADED, "personal-ids", false);
    const failed = withFailed(pending, "personal-ids", true);
    expect(failed.pending.size).toBe(0);
    expect(failed.settings?.presets[0]?.enabled).toBe(true);
    expect(failed.error).toBe("Couldn't save that change. Try again.");
  });
});
