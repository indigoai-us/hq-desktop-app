import { describe, expect, it } from "vitest";
import { finishNavigatesToCompany } from "./welcome-finish.js";

describe("finishNavigatesToCompany", () => {
  it("stays on the welcome report while a Connect is waiting for the new company", () => {
    expect(finishNavigatesToCompany(true)).toBe(false);
  });

  it("opens the company when the finish did not come from the welcome report", () => {
    expect(finishNavigatesToCompany(false)).toBe(true);
  });
});
