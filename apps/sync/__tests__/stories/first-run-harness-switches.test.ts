// The preview harness's switches for the visual first run's "Your team",
// Note taker and Project management screens (dev-harness/first-run-fixtures.ts).
// Preview only: off unless the URL names them, and only with ?firstrun=.
import { describe, expect, it } from "vitest";

import { switchedHandler } from "../../dev-harness/audit-switches";
import { appsSwitch, firstRunScreensAnswer, teamSwitch, teamWorkspaces } from "../../dev-harness/first-run-fixtures";

describe("first-run harness switches", () => {
  it("are off by default and accept only their listed values", () => {
    expect(teamSwitch("")).toBeNull();
    expect(appsSwitch("")).toBeNull();
    expect(teamSwitch("?team=bogus")).toBeNull();
    expect(appsSwitch("?apps=1")).toBeNull();
    expect(teamSwitch("?team=invites")).toBe("invites");
    expect(appsSwitch("?apps=forbidden")).toBe("forbidden");
    expect(firstRunScreensAnswer("list_syncable_workspaces", undefined, "")).toBeUndefined();
  });

  it("only answer under a ?firstrun= switch", () => {
    expect(switchedHandler("list_syncable_workspaces", undefined, "?team=member")).toBeUndefined();
    const answer = switchedHandler("list_syncable_workspaces", undefined, "?firstrun=visual&team=member") as {
      value: { workspaces: Array<{ slug: string; membershipStatus: string | null }> };
    };
    expect(answer.value.workspaces.map((w) => w.slug)).toEqual(["personal", "acme-robotics"]);
  });

  it("give each roster its shape", () => {
    const pending = (kind: Parameters<typeof teamWorkspaces>[0]) =>
      teamWorkspaces(kind).filter((w) => w.membershipStatus === "pending").length;
    expect(pending("invites")).toBe(2);
    expect(pending("member")).toBe(0);
    expect(teamWorkspaces("many").length).toBeGreaterThan(12);
  });

  it("refuse the catalog read under ?apps=forbidden", () => {
    const answer = firstRunScreensAnswer(
      "hq_pro_fetch",
      { url: "/v1/integrations/factory/catalog?companyUid=cmp_acme&query=&limit=100" },
      "?apps=forbidden",
    ) as { value: { status: number } };
    expect(answer.value.status).toBe(403);
  });
});
