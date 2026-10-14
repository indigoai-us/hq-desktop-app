import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_ROW_STATE,
  REDACTION_PRESETS,
  RedactionError,
  createRedactionPresetsApi,
  enabledPresetIds,
  isRedactionUnsupported,
  loadFailureLine,
  parseRedactionAnswer,
  rowCanEdit,
  saveFailureLine,
  viewerCanEditRedaction,
  withFailed,
  withSaved,
  withToggle,
  type RedactionRowState,
} from "./redaction-presets";

const ALL = ["personal-ids", "hr-pay", "legal", "financial"];

const LOADED: RedactionRowState = {
  settings: parseRedactionAnswer({ presets: ["personal-ids", "hr-pay", "financial"], canEdit: true }),
  pending: new Set(),
  error: null,
};

describe("US-005 redaction presets model (US-004 contract)", () => {
  it("uses the four hq-pro #4910 presets in canonical order", () => {
    expect(REDACTION_PRESETS.map((p) => [p.id, p.label])).toEqual([
      ["personal-ids", "Personal IDs"],
      ["hr-pay", "Salary and HR"],
      ["legal", "Legal matters"],
      ["financial", "Bank and card numbers"],
    ]);
  });

  it("reads presets as the list of ids that are on", () => {
    const s = parseRedactionAnswer({
      companyUid: "cmp_x",
      connectionId: "conn_1",
      presets: ["financial", "personal-ids", "unknown"],
      availablePresets: ALL,
      isDefault: false,
      updatedAt: null,
      updatedBy: null,
      canEdit: false,
    });
    expect(s.presets.map((p) => [p.id, p.enabled])).toEqual([
      ["personal-ids", true],
      ["hr-pay", false],
      ["legal", false],
      ["financial", true],
    ]);
    expect(s.canEdit).toBe(false);
    expect(enabledPresetIds(s)).toEqual(["personal-ids", "financial"]);
  });

  it("treats a missing list as all off (opt-in) and [] as all off", () => {
    expect(parseRedactionAnswer({}).presets).toHaveLength(4);
    expect(parseRedactionAnswer({}).presets.some((p) => p.enabled)).toBe(false);
    expect(parseRedactionAnswer({ availablePresets: ["legal"] }).presets).toEqual([
      { id: "legal", label: "Legal matters", enabled: false },
    ]);
    expect(parseRedactionAnswer({}).canEdit).toBeNull();
    expect(parseRedactionAnswer({ presets: [] }).presets.some((p) => p.enabled)).toBe(false);
  });

  it("shows only the available presets, and all four when none are named", () => {
    const narrowed = parseRedactionAnswer({ presets: ALL, availablePresets: [{ id: "legal" }, "hr-pay"] });
    expect(narrowed.presets.map((p) => p.id)).toEqual(["hr-pay", "legal"]);
    expect(parseRedactionAnswer({ presets: ALL, availablePresets: ["other"] }).presets).toHaveLength(4);
  });

  it("builds the API from the platform client and keeps refusal codes", async () => {
    expect(createRedactionPresetsApi(null)).toBeNull();
    expect(createRedactionPresetsApi({ getRedaction: vi.fn() })).toBeNull();
    const putRedaction = vi.fn(async () => ({
      ok: false as const,
      reason: "error" as const,
      code: "REDACTION_ADMIN_REQUIRED",
      status: 403,
    }));
    const getRedaction = vi.fn(async () => ({ ok: true as const, value: { presets: ["legal"], canEdit: true } }));
    const api = createRedactionPresetsApi({ getRedaction, putRedaction })!;
    expect((await api.load("cmp_x", "conn_1")).presets.find((p) => p.id === "legal")?.enabled).toBe(true);
    await expect(api.save("cmp_x", "conn_1", ["legal"])).rejects.toMatchObject({
      code: "REDACTION_ADMIN_REQUIRED",
      status: 403,
    });
    expect(putRedaction).toHaveBeenCalledWith("cmp_x", "conn_1", ["legal"]);
  });

  it("maps refusals to short plain lines", () => {
    const admin = new RedactionError("REDACTION_ADMIN_REQUIRED", 403);
    const gone = new RedactionError("CONNECTION_NOT_FOUND", 404);
    const invalid = new RedactionError("REDACTION_REQUEST_INVALID", 400);
    expect(saveFailureLine(admin)).toBe("Only owners and admins can change this.");
    expect(saveFailureLine(gone)).toBe("This connection is no longer connected.");
    expect(saveFailureLine(invalid)).toBe("Couldn't save that change. Try again.");
    expect(saveFailureLine(new Error("x"))).toBe("Couldn't save that change. Try again.");
    expect(loadFailureLine(gone)).toBe("This connection is no longer connected.");
    expect(isRedactionUnsupported(new RedactionError("http-404", 404))).toBe(true);
    expect(isRedactionUnsupported(gone)).toBe(false);
  });

  it("lets owners and admins edit unless the server says no", () => {
    expect(viewerCanEditRedaction({ viewer: { role: "owner" } })).toBe(true);
    expect(viewerCanEditRedaction({ viewer: { role: "admin", canManageIntegrations: false } })).toBe(true);
    expect(viewerCanEditRedaction({ viewer: { role: "member", canManageIntegrations: true } })).toBe(false);
    expect(viewerCanEditRedaction({ viewer: { canManageIntegrations: true } })).toBe(true);
    expect(viewerCanEditRedaction(null)).toBe(false);
    expect(rowCanEdit(true, LOADED.settings)).toBe(true);
    expect(rowCanEdit(true, { ...LOADED.settings!, canEdit: false })).toBe(false);
    expect(rowCanEdit(false, LOADED.settings)).toBe(false);
  });

  it("shows the requested value as pending, then takes the server answer", () => {
    const pending = withToggle(LOADED, "legal", true);
    expect(pending.pending.has("legal")).toBe(true);
    expect(enabledPresetIds(pending.settings!)).toEqual(ALL);
    expect(withToggle(EMPTY_ROW_STATE, "legal", false)).toBe(EMPTY_ROW_STATE);
    const saved = withSaved(pending, "legal", parseRedactionAnswer({ presets: ["legal"], canEdit: true }));
    expect(saved.pending.size).toBe(0);
    expect(enabledPresetIds(saved.settings!)).toEqual(["legal"]);
  });

  it("keeps a still-pending preset when another save answers", () => {
    const two = withToggle(withToggle(LOADED, "legal", true), "hr-pay", false);
    const saved = withSaved(two, "legal", parseRedactionAnswer({ presets: ["personal-ids", "hr-pay", "legal", "financial"] }));
    expect(saved.pending.has("hr-pay")).toBe(true);
    expect(saved.settings!.presets.find((p) => p.id === "hr-pay")?.enabled).toBe(false);
  });

  it("rolls back on a refused PUT and goes read-only on a 403", () => {
    const pending = withToggle(LOADED, "personal-ids", false);
    const failed = withFailed(pending, "personal-ids", true, new RedactionError("REDACTION_ADMIN_REQUIRED", 403));
    expect(failed.pending.size).toBe(0);
    expect(failed.settings!.presets[0]!.enabled).toBe(true);
    expect(failed.settings!.canEdit).toBe(false);
    expect(failed.error).toBe("Only owners and admins can change this.");
    const net = withFailed(pending, "personal-ids", true, new Error("offline"));
    expect(net.settings!.canEdit).toBe(true);
    expect(net.error).toBe("Couldn't save that change. Try again.");
  });
});
