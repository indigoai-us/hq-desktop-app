import { describe, expect, it, vi } from "vitest";
import {
  billingPortalUrl,
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

  it("hands upgrade to Stripe checkout and rejects non-Stripe hosts", () => {
    expect(new URL(stripeDestination("upgrade")).hostname).toBe("checkout.stripe.com");
    expect(approvedStripeUrl("http://checkout.stripe.com/c/pay/x")).toBeNull();
    expect(approvedStripeUrl("https://evil.example/checkout")).toBeNull();
  });
});

describe("billingPortalUrl", () => {
  const FALLBACK = "https://hq.computer/companies/acme/billing";
  const SESSION = "https://billing.stripe.com/p/session/live_abc123";

  it("opens the portal session hq-pro minted, never a fixed portal link", async () => {
    const mint = vi.fn(async () => ({ ok: true as const, value: { url: SESSION } }));
    await expect(billingPortalUrl(mint, FALLBACK)).resolves.toBe(SESSION);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("falls back to the console billing page when there is no mint", async () => {
    await expect(billingPortalUrl(null, FALLBACK)).resolves.toBe(FALLBACK);
  });

  it("falls back when hq-pro refuses (non-owner 403)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mint = async () => ({ ok: false as const, code: "http-403", message: "Requires owner role" });
    await expect(billingPortalUrl(mint, FALLBACK)).resolves.toBe(FALLBACK);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back when the mint throws or answers a non-portal url", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(billingPortalUrl(async () => { throw new Error("offline"); }, FALLBACK)).resolves.toBe(FALLBACK);
    await expect(billingPortalUrl(async () => ({ ok: true as const, value: { url: "https://evil.example/p" } }), FALLBACK)).resolves.toBe(FALLBACK);
    await expect(billingPortalUrl(async () => ({ ok: true as const, value: { url: "https://checkout.stripe.com/c/pay/x" } }), FALLBACK)).resolves.toBe(FALLBACK);
    await expect(billingPortalUrl(async () => ({ ok: true as const, value: {} }), FALLBACK)).resolves.toBe(FALLBACK);
    warn.mockRestore();
  });
});
