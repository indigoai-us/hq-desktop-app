import { describe, expect, it } from "vitest";

import {
  blockedNote,
  canManageRole,
  failureCopy,
  jobHealthSummary,
  lastSeenLabel,
  listAfterProvision,
  mapLifecycleState,
  nextOutpostName,
  publicMachine,
  renameError,
  stateLabel,
  emptyHealth,
  type CompanyOutpostListItem,
  type ProvisionResult,
} from "./company-outpost-model.js";

const box = (id: string): CompanyOutpostListItem => ({
  id,
  name: id,
  state: "running",
  lastSeenAt: null,
  jobsCount: 0,
  jobHealth: emptyHealth(),
});

describe("company outpost model", () => {
  it("labels the four list states", () => {
    expect(stateLabel("running")).toBe("Running");
    expect(stateLabel("preparing")).toBe("Preparing");
    expect(stateLabel("needs_attention")).toBe("Needs attention");
    expect(stateLabel("blocked")).toBe("Blocked");
  });

  it("maps lifecycle words onto those states", () => {
    expect(mapLifecycleState({ state: "ready" })).toBe("running");
    expect(mapLifecycleState({ state: "provisioning" })).toBe("preparing");
    expect(mapLifecycleState({ state: "stopped" })).toBe("needs_attention");
    expect(mapLifecycleState({ state: "outcome_unknown" })).toBe("blocked");
    expect(mapLifecycleState({ state: "ready", blocked: true })).toBe("blocked");
    expect(mapLifecycleState({ state: "ready", signedIn: false })).toBe("needs_attention");
    expect(mapLifecycleState({ state: "starting" })).toBe("preparing");
  });

  it("summarizes job health in plain words", () => {
    expect(jobHealthSummary({ ok: 1, missed: 1, blocked: 0, stale: 1, unknown: 0 }, 3)).toBe("1 ran on time, 1 missed, 1 out of date");
    expect(jobHealthSummary(emptyHealth(), 0)).toBe("No jobs");
  });

  it("says when the box was last seen", () => {
    const now = Date.parse("2026-10-18T16:00:00.000Z");
    expect(lastSeenLabel("2026-10-18T15:00:00.000Z", now)).toBe("Last seen 1 hour ago");
    expect(lastSeenLabel(null, now)).toBe("Last seen never");
  });

  it("uses the prototype blocked note for admins and members", () => {
    expect(blockedNote("admin")).toBe("This Outpost needs attention. Scheduled jobs are paused. HQ has been notified and will follow up by email. You can also remove it and add a new one.");
    expect(blockedNote("member")).toBe("This Outpost needs attention. Scheduled jobs are paused. An owner or admin has been notified.");
    expect(canManageRole("owner")).toBe(true);
    expect(canManageRole("admin")).toBe(true);
    expect(canManageRole("member")).toBe(false);
    expect(canManageRole("guest")).toBe(false);
  });

  it("does not add a box unless provision succeeded", () => {
    const before = [box("demo-1")];
    const failure: ProvisionResult = { status: "failure", message: failureCopy() };
    expect(listAfterProvision(before, failure)).toEqual(before);
    expect(listAfterProvision(before, { status: "pending", attemptId: "a" })).toEqual(before);
    expect(listAfterProvision(before, { status: "already_exists", outpostId: "ghost" })).toEqual(before);
    expect(listAfterProvision(before, { status: "unavailable" })).toEqual(before);
    expect(listAfterProvision(before, { status: "forbidden" })).toEqual(before);
    const added = listAfterProvision(before, { status: "success", outpost: box("demo-new") });
    expect(added.map((item) => item.id)).toEqual(["demo-1", "demo-new"]);
  });

  it("says a failed provision did not add an Outpost", () => {
    expect(failureCopy()).toBe("The Outpost was not added.");
  });

  it("picks a generated name that is not already used", () => {
    expect(nextOutpostName([])).toBe("quiet-pine");
    expect(nextOutpostName(["quiet-pine"])).toBe("clear-brook");
  });

  it("rejects a rename that is not a short dashed name", () => {
    expect(renameError("Weekly Reports")).toMatch(/lowercase/);
    expect(renameError("ok-name")).toBe("");
  });

  it("drops secret-like machine fields", () => {
    const machine = publicMachine({
      region: "US East",
      instanceId: "i-1",
      createdAt: "October 17, 2026",
      sessionToken: "sk-secret",
      refreshToken: "refresh-secret",
    });
    expect(machine).toEqual({ region: "US East", instanceId: "i-1", createdAt: "October 17, 2026" });
    expect(JSON.stringify(machine)).not.toContain("sk-secret");
  });
});
