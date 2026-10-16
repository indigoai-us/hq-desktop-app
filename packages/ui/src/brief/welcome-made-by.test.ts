import { describe, expect, it } from "vitest";

import { welcomeMadeBy } from "./welcome-made-by.js";

describe("welcomeMadeBy", () => {
  const assistant = { name: "Peanut", onmeet: () => undefined };

  it("names the assistant once its report has landed and is on screen", () => {
    expect(welcomeMadeBy(assistant, "run-2", "run-2")).toBe(assistant);
  });

  it("leaves the line out while the assistant has made no report yet", () => {
    expect(welcomeMadeBy(assistant, null, null)).toBeUndefined();
    expect(welcomeMadeBy(assistant, null, "run-1")).toBeUndefined();
  });

  it("leaves the line out when the page shows a different run than the one that landed", () => {
    expect(welcomeMadeBy(assistant, "run-2", "run-1")).toBeUndefined();
    expect(welcomeMadeBy(assistant, "run-2", null)).toBeUndefined();
  });

  it("shows no line at all when there is no assistant", () => {
    expect(welcomeMadeBy(null, null, null)).toBeUndefined();
    expect(welcomeMadeBy(null, "run-2", "run-2")).toBeUndefined();
  });
});
