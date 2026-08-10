import { describe, expect, it } from "vitest";

import {
  compareVersions,
  decide,
  parseArgs,
  parseVersion,
  readProductVersion,
} from "./release-version-order.mjs";

describe("release-version-order", () => {
  it("reads the [product] version and ignores other tables", () => {
    const versionsToml = [
      "# Single source of truth.",
      "",
      "[product]",
      'name = "HQ Sync"',
      'version = "0.10.95"',
      'base_crate = "hq-sync-menubar"',
      "",
      "[updater]",
      'manifest_base = "https://example.invalid"',
      "",
    ].join("\n");

    expect(readProductVersion(versionsToml)).toBe("0.10.95");
  });

  it("rejects a versions.toml without a product version", () => {
    expect(() => readProductVersion("[updater]\nchannels = []\n"))
      .toThrow("versions.toml is missing [product]");
  });

  it("parses prerelease identifiers", () => {
    expect(parseVersion("1.2.3-beta.4")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.4",
    });
  });

  it("rejects a tag-shaped version", () => {
    expect(() => parseVersion("v1.2.3")).toThrow("Not a semantic version: v1.2.3");
  });

  it("orders core versions numerically, not lexically", () => {
    // The bug this guards: "0.10.9" > "0.9.2" is false as a string compare.
    expect(compareVersions("0.10.9", "0.9.2")).toBeGreaterThan(0);
    expect(compareVersions("0.10.95", "0.10.100")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("ranks a release above its own prereleases", () => {
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBeLessThan(0);
  });

  it("orders prerelease identifiers by SemVer rules", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-beta.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta.1.1", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("proceeds only when the candidate is strictly newer", () => {
    expect(decide({ current: "0.10.95", candidate: "0.10.96" })).toBe("proceed");
    expect(decide({ current: "0.10.95", candidate: "0.10.95" })).toBe("skip");
    expect(decide({ current: "0.10.96", candidate: "0.10.95" })).toBe("skip");
  });

  it("proceeds from a prerelease to its release, but not back", () => {
    expect(decide({ current: "0.10.96-beta.0", candidate: "0.10.96" })).toBe("proceed");
    expect(decide({ current: "0.10.96", candidate: "0.10.96-beta.0" })).toBe("skip");
  });

  it("requires a candidate and a source for the current version", () => {
    expect(() => parseArgs(["--current", "1.0.0"])).toThrow("--candidate is required");
    expect(() => parseArgs(["--candidate", "1.0.0"]))
      .toThrow("one of --current or --versions-file is required");
    expect(() => parseArgs(["--candidate"])).toThrow("--candidate requires a value");
    expect(() => parseArgs(["--nope", "x"])).toThrow("Unknown argument: --nope");
  });
});
