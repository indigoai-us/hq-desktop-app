import { describe, expect, it } from "vitest";
import {
  headerEditableStatus,
  projectListStatus,
  secondaryPlanStatusLabel,
} from "./projects-model.js";

describe("project detail header status (QA-062)", () => {
  it("shows Complete when the board column is Complete even if the planning status is planned", () => {
    const fixture = { status: "planned", storiesComplete: 32, storiesTotal: 32 };
    expect(projectListStatus(fixture)).toBe("complete");
    expect(headerEditableStatus(fixture)).toBe("completed");
    expect(secondaryPlanStatusLabel(fixture)).toBe("Plan: Planned");
  });

  it("keeps the raw status and no secondary label when board and plan agree", () => {
    const planned = { status: "planned", storiesComplete: 0, storiesTotal: 5 };
    expect(headerEditableStatus(planned)).toBe("planned");
    expect(secondaryPlanStatusLabel(planned)).toBeNull();
    const prd = { status: "prd_created", storiesComplete: 0, storiesTotal: 5 };
    expect(headerEditableStatus(prd)).toBe("prd_created");
  });

  it("maps in-flight and archived board columns onto the header", () => {
    expect(headerEditableStatus({ status: "planned", storiesComplete: 2, storiesTotal: 5 })).toBe("in_progress");
    expect(headerEditableStatus({ status: "archived", storiesComplete: 5, storiesTotal: 5 })).toBe("archived");
  });
});
