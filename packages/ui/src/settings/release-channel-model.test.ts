import { describe, expect, it } from "vitest";
import {
  channelDowngradeNotice,
  channelOptions,
  compareVersions,
  normalizeChannel,
  selectedChannel,
} from "./release-channel-model";

describe("release channel options", () => {
  it("shows only host-permitted channels, in canonical order", () => {
    expect(channelOptions(["beta", "stable", "alpha"]).map((o) => o.id)).toEqual([
      "stable",
      "beta",
      "alpha",
    ]);
    expect(channelOptions(["stable"]).map((o) => o.id)).toEqual(["stable"]);
  });

  it("falls back to Stable when the host list is empty or unreadable", () => {
    expect(channelOptions([]).map((o) => o.id)).toEqual(["stable"]);
    expect(channelOptions(null).map((o) => o.id)).toEqual(["stable"]);
    expect(channelOptions(["nonsense"]).map((o) => o.id)).toEqual(["stable"]);
  });

  it("normalizes stored values", () => {
    expect(normalizeChannel("Beta")).toBe("beta");
    expect(normalizeChannel(" ALPHA ")).toBe("alpha");
    expect(normalizeChannel("rc")).toBeNull();
    expect(normalizeChannel(null)).toBeNull();
  });
});

describe("selected channel reflects the host's derived default", () => {
  it("uses the stored preference when the user has chosen", () => {
    expect(selectedChannel("alpha", "beta")).toBe("alpha");
  });

  it("falls back to the host's effective channel when never chosen", () => {
    expect(selectedChannel(null, "beta")).toBe("beta");
  });

  it("defaults to stable when nothing is known", () => {
    expect(selectedChannel(null, null)).toBe("stable");
  });

  it("a non-Indigo customer who picked Beta keeps Beta", () => {
    expect(selectedChannel("beta", "stable")).toBe("beta");
    expect(channelOptions(["stable", "beta", "alpha"]).map((o) => o.id)).toEqual([
      "stable",
      "beta",
      "alpha",
    ]);
  });
});

describe("version ordering", () => {
  it("ranks prereleases below the matching stable release", () => {
    expect(compareVersions("0.10.173-beta.2", "0.10.173")).toBeLessThan(0);
    expect(compareVersions("0.10.173-alpha.9", "0.10.173-beta.1")).toBeLessThan(0);
    expect(compareVersions("0.10.173-beta.2", "0.10.173-beta.10")).toBeLessThan(0);
    expect(compareVersions("0.10.174", "0.10.173-beta.2")).toBeGreaterThan(0);
    expect(compareVersions("v0.10.173", "0.10.173")).toBe(0);
  });
});

describe("downgrade guard", () => {
  it("explains the wait instead of offering an older build (owner's case)", () => {
    const notice = channelDowngradeNotice("0.10.173-beta.2", "stable", "0.10.172");
    expect(notice.isDowngrade).toBe(true);
    expect(notice.message).toContain("newer build than Stable");
    expect(notice.message).toContain("next stable release");
  });

  it("stays silent when the channel offers the same or a newer build", () => {
    expect(
      channelDowngradeNotice("0.10.173-beta.2", "stable", "0.10.174").isDowngrade,
    ).toBe(false);
    expect(
      channelDowngradeNotice("0.10.173", "stable", "0.10.173").isDowngrade,
    ).toBe(false);
  });

  it("stays silent when either version is unknown", () => {
    expect(channelDowngradeNotice(null, "beta", "0.10.172").isDowngrade).toBe(false);
    expect(channelDowngradeNotice("0.10.173", "beta", null).isDowngrade).toBe(false);
  });
});
