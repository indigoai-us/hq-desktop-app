import { describe, expect, it } from "vitest";

import { welcomeMadeBy } from "./welcome-made-by.js";

describe("welcomeMadeBy", () => {
  const assistant = { name: "Peanut", onmeet: () => undefined };

  it("names the assistant once its report has landed", () => {
    expect(welcomeMadeBy(assistant, true)).toBe(assistant);
  });

  it("leaves the line out while the assistant has made no report yet", () => {
    expect(welcomeMadeBy(assistant, false)).toBeUndefined();
  });

  it("says the assistant will make the next one when there is none", () => {
    expect(welcomeMadeBy(null, false)).toBeNull();
    expect(welcomeMadeBy(null, true)).toBeNull();
  });
});
