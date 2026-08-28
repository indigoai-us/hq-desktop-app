import { describe, expect, it } from "vitest";
import { classNames } from "./class-names.js";

describe("classNames", () => {
  it("joins truthy fragments and drops falsy ones", () => {
    expect(classNames("btn", undefined, "btn-primary", false, null)).toBe(
      "btn btn-primary",
    );
    expect(classNames()).toBe("");
  });
});
