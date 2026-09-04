import { describe, expect, it } from "vitest";
import { displayVersion } from "./version.js";

describe("displayVersion", () => {
  it("falls back to dev without a tag", () => {
    expect(displayVersion(undefined)).toBe("dev");
  });
  it("uses the tag version when present", () => {
    expect(displayVersion("v2.0.0")).toBe("2.0.0");
  });
});
