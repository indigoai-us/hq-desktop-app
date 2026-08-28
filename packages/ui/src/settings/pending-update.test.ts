import { describe, expect, it } from "vitest";
import { resolvePendingUpdateState } from "./pending-update";

describe("resolvePendingUpdateState", () => {
  it('treats null as an authoritative "no update"', () => {
    expect(resolvePendingUpdateState(null)).toEqual({
      state: "resolved",
      value: null,
    });
  });

  it("unwraps the explicit tri-state", () => {
    const update = { version: "1.2.3" };
    expect(resolvePendingUpdateState({ status: "pending", update })).toEqual({
      state: "resolved",
      value: update,
    });
    expect(resolvePendingUpdateState({ status: "absent" })).toEqual({
      state: "resolved",
      value: null,
    });
    expect(resolvePendingUpdateState({ status: "unchecked" })).toEqual({
      state: "unchecked",
      value: null,
    });
  });

  it("keeps legacy bare UpdateInfo payloads compatible", () => {
    expect(resolvePendingUpdateState({ version: "9.9.9" })).toEqual({
      state: "resolved",
      value: { version: "9.9.9" },
    });
  });
});
