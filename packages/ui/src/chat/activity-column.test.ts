import { describe, expect, it } from "vitest";
import type { MessageType } from "@hq/platform";
import {
  ACTIVITY_NARROW_QUERY,
  activityHiddenCount,
  activityRows,
  lensFor,
  lensLabel,
  lensPrefs,
} from "./activity-column.js";

const rows: Array<{ id: string; type: MessageType }> = [
  { id: "h1", type: "people" },
  { id: "a1", type: "agent" },
  { id: "s1", type: "system" },
  { id: "a2", type: "agent" },
];
const typeOf = (r: { type: MessageType }) => r.type;

describe("activity-column helpers", () => {
  it("counts agent and system rows the filter hides", () => {
    expect(activityHiddenCount(rows, { agents: false, system: false }, typeOf)).toBe(3);
    expect(activityHiddenCount(rows, { agents: true, system: false }, typeOf)).toBe(1);
    expect(activityHiddenCount(rows, { agents: true, system: true }, typeOf)).toBe(0);
    expect(activityHiddenCount(rows, null, typeOf)).toBe(0);
  });

  it("keeps timeline order per segment", () => {
    expect(activityRows(rows, "agents", typeOf).map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(activityRows(rows, "system", typeOf).map((r) => r.id)).toEqual(["s1"]);
  });

  it("maps lenses to filters and back", () => {
    for (const lens of ["people", "agents", "system", "all"] as const) {
      expect(lensFor(lensPrefs(lens))).toBe(lens);
    }
    expect(lensLabel("people")).toBe("People");
    expect(lensFor(null)).toBe("all");
  });

  it("is narrow below 1000px", () => {
    expect(ACTIVITY_NARROW_QUERY).toBe("(max-width: 999px)");
  });
});
