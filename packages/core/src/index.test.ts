import { describe, expect, it } from "vitest";
import { channelFromTag, versionFromTag } from "./index.js";

describe("versionFromTag", () => {
  it("parses stable tags", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
  });
  it("parses prerelease tags", () => {
    expect(versionFromTag("v1.2.3-alpha.4")).toBe("1.2.3-alpha.4");
  });
  it("rejects malformed tags", () => {
    expect(() => versionFromTag("1.2.3")).toThrow();
    expect(() => versionFromTag("v1.2")).toThrow();
    expect(() => versionFromTag("v1.2.3-rc.1")).toThrow();
  });
});

describe("channelFromTag", () => {
  it("classifies channels", () => {
    expect(channelFromTag("v1.2.3")).toBe("stable");
    expect(channelFromTag("v1.2.3-alpha.1")).toBe("alpha");
    expect(channelFromTag("v1.2.3-beta.2")).toBe("beta");
  });
});
