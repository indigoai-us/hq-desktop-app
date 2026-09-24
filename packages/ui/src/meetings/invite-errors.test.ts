import { describe, expect, it } from "vitest";
import { isPlanRequiredError, planRequiredUpgradeUrl } from "./invite-errors";

const planError = (upgradeUrl: string) =>
  `bot/invite HTTP 402: {"code":"MEETING_PLAN_REQUIRED","upgradeUrl":${JSON.stringify(upgradeUrl)}}`;

describe("plan-required upgrade URL", () => {
  it("returns the server-selected company billing URL", () => {
    const upgradeUrl = "https://hq.computer/companies/acme/billing?upgrade=team";

    expect(planRequiredUpgradeUrl(planError(upgradeUrl))).toBe(upgradeUrl);
  });

  it.each([
    ["javascript protocol", "javascript:alert(1)"],
    ["file protocol", "file:///etc/passwd"],
    ["custom protocol", "hq-upgrade:open"],
    ["non-HTTPS URL", "http://hq.computer/companies/acme/billing"],
    ["credentialed URL", "https://user:pass@hq.computer/companies/acme/billing"],
    ["padded URL", " https://hq.computer/billing"],
  ])("rejects a %s from the plan response", (_name, upgradeUrl) => {
    expect(isPlanRequiredError(planError(upgradeUrl))).toBe(true);
    expect(planRequiredUpgradeUrl(planError(upgradeUrl))).toBeUndefined();
  });

  it("does not infer a URL when the server body is absent or malformed", () => {
    expect(planRequiredUpgradeUrl("bot/invite HTTP 402: no body")).toBeUndefined();
    expect(
      planRequiredUpgradeUrl('bot/invite HTTP 402: {"upgradeUrl":"https://hq.computer'),
    ).toBeUndefined();
  });
});
