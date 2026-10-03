import { describe, expect, it } from "vitest";
import {
  deleteGroup,
  emptySnapshot,
  filterGrants,
  GRANT_LEVELS,
  metadata,
  stripeDestination,
  approvedStripeUrl,
  type CompanyGroup,
  type PathGrant,
} from "./company-settings.js";

const groups: CompanyGroup[] = [
  {
    id: "ops",
    name: "Ops",
    description: "Ops",
    members: [],
    paths: [{ path: "knowledge/finance/*", level: "read" }],
  },
];

const grants: PathGrant[] = [
  { id: "1", principal: "Andrew N.", detail: "andrew@getindigo.ai", kind: "person", path: "projects/a/*", level: "write", expiry: "Oct 3", expiring: true, grantedBy: "Maggie" },
  { id: "2", principal: "Engineering", detail: "grp", kind: "group", path: "secrets/indigo/*", level: "read", expiry: "never", expiring: false, grantedBy: "Corey" },
  { id: "3", principal: "deacon", detail: "agent", kind: "agent", path: "secrets/indigo/deploy/*", level: "read", expiry: "never", expiring: false, grantedBy: "Corey" },
  { id: "4", principal: "Priya D.", detail: "guest", kind: "guest", path: "projects/pe/*", level: "read", expiry: "Oct 14", expiring: true, grantedBy: "Corey" },
];

describe("US-030 company settings", () => {
  it("keeps the scroll budget inside one percent", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
  });

  it("filters grants by people, groups, agents, guests, and expiring", () => {
    expect(filterGrants(grants, "all")).toHaveLength(4);
    expect(filterGrants(grants, "people").map((g) => g.id)).toEqual(["1"]);
    expect(filterGrants(grants, "groups").map((g) => g.id)).toEqual(["2"]);
    expect(filterGrants(grants, "agents").map((g) => g.id)).toEqual(["3"]);
    expect(filterGrants(grants, "guests").map((g) => g.id)).toEqual(["4"]);
    expect(filterGrants(grants, "expiring").map((g) => g.id)).toEqual(["1", "4"]);
  });

  it("allows only read and write grant levels", () => {
    expect(GRANT_LEVELS).toEqual(["read", "write"]);
    expect(emptySnapshot("Indigo", "indigo").groups).toEqual([]);
  });

  it("deletes a group only after confirmation", () => {
    expect(deleteGroup(groups, "ops", false)).toEqual(groups);
    expect(deleteGroup(groups, "ops", true)).toEqual([]);
  });

  it("hands upgrade to Stripe checkout and payment to the portal", () => {
    expect(new URL(stripeDestination("upgrade")).hostname).toBe("checkout.stripe.com");
    expect(new URL(stripeDestination("portal")).hostname).toBe("billing.stripe.com");
    expect(approvedStripeUrl("http://checkout.stripe.com/c/pay/x")).toBeNull();
    expect(approvedStripeUrl("https://evil.example/checkout")).toBeNull();
  });
});
