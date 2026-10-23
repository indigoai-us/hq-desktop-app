import { describe, expect, it, vi } from "vitest";
import {
  DomainRequestError,
  isRetryableReadError,
  listWithRetry,
  canManageDomains,
  dnsRecordsFor,
  domainErrorCopy,
  domainInputProblem,
  domainPricesFromFeed,
  awaitOwnershipRecord,
  companyDomainPriceFrom,
  domainMonthlyUsd,
  domainPriceLine,
  domainStatus,
  hasOwnershipRecord,
  hostSegments,
  liveCustomDomainUrl,
  normalizeDomainInput,
  routingTargetFor,
  trustedBillingUrl,
} from "./custom-domain.js";

describe("US-007 custom-domain model", () => {
  it("reads the domain prices from the pricing feed, and nothing malformed", () => {
    expect(domainPricesFromFeed({ usage: { domains: { standardUsd: 20, premiumUsd: 500 } } })).toEqual({ standardUsd: 20, premiumUsd: 500 });
    expect(domainPricesFromFeed({ usage: { domains: { standardUsd: "20", premiumUsd: 500 } } })).toBeNull();
    expect(domainPricesFromFeed({ usage: {} })).toBeNull();
    expect(domainPricesFromFeed(null)).toBeNull();
  });

  it("normalizes typed input and flags invalid and reserved hostnames", () => {
    expect(normalizeDomainInput(" HTTPS://App.Example.com:443/path?q=1 ")).toBe("app.example.com");
    expect(normalizeDomainInput("example.com.")).toBe("example.com");
    expect(domainInputProblem("")).toBe("empty");
    expect(domainInputProblem("example")).toBe("invalid");
    expect(domainInputProblem("-bad.example.com")).toBe("invalid");
    expect(domainInputProblem("10.0.0.1")).toBe("invalid");
    for (const reserved of ["hq.work", "x.hq.work", "a.indigo-hq.com", "hq.computer", "getindigo.ai"]) {
      expect(domainInputProblem(reserved)).toBe("reserved");
    }
    expect(domainInputProblem("app.yousufkalim.com")).toBeNull();
  });

  it("points the routing record at the provisioned indigo-hq.com host, as hq-deploy does", () => {
    expect(routingTargetFor("hq-lifecycle-email-map.hq.work")).toBe("hq-lifecycle-email-map.indigo-hq.com");
    expect(routingTargetFor("launch-notes.indigo-hq.com")).toBe("launch-notes.indigo-hq.com");
    expect(dnsRecordsFor("yousufkalim.com", "hq-lifecycle-email-map.hq.work", [])).toEqual([
      { type: "CNAME", name: "yousufkalim.com", value: "hq-lifecycle-email-map.indigo-hq.com", purpose: "routing" },
    ]);
  });

  it("waits for the certificate record before handing back the DNS records", async () => {
    const routing = { type: "CNAME", name: "app.example.com", value: "launch-notes.indigo-hq.com" };
    const cert = { type: "CNAME", name: "_a.app.example.com.", value: "_b.acm-validations.aws." };
    const pendingReply = (instructions: unknown[]) => ({ state: "pending" as const, serving: false, certStatus: "PENDING_VALIDATION", instructions });
    const refresh = vi.fn().mockResolvedValueOnce(pendingReply([])).mockResolvedValueOnce(pendingReply([cert]));
    const result = await awaitOwnershipRecord({ refresh }, "app_1", "app.example.com", [routing], [0, 0, 0]);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(hasOwnershipRecord("app.example.com", result.instructions)).toBe(true);
    expect(dnsRecordsFor("app.example.com", "", result.instructions).map((r) => r.purpose)).toEqual(["ownership", "routing"]);
    expect(result.last?.certStatus).toBe("PENDING_VALIDATION");

    // Already complete: no extra read.
    const unused = vi.fn();
    await awaitOwnershipRecord({ refresh: unused }, "app_1", "app.example.com", [cert, routing], [0]);
    expect(unused).not.toHaveBeenCalled();

    // Never arrives: stops after the last delay with what it has.
    const empty = vi.fn().mockResolvedValue(pendingReply([]));
    const partial = await awaitOwnershipRecord({ refresh: empty }, "app_1", "app.example.com", [routing], [0, 0]);
    expect(empty).toHaveBeenCalledTimes(3);
    expect(hasOwnershipRecord("app.example.com", partial.instructions)).toBe(false);
  });

  it("reports Waiting for DNS, Verifying and Live, and splits long names after dots", () => {
    const pendingRecord = { domain: "mysite.com", state: "pending" as const };
    expect(domainStatus(pendingRecord, false).tone).toBe("waiting");
    expect(domainStatus(pendingRecord, false, "PENDING_VALIDATION", true)).toEqual({ tone: "verifying", label: "Verifying" });
    expect(domainStatus(pendingRecord, false, "ISSUED").label).toBe("Verifying");
    expect(domainStatus(pendingRecord, true).label).toBe("Live");
    expect(domainStatus({ domain: "mysite.com", state: "failed" }, false).tone).toBe("failed");
    expect(hostSegments("_3f1c9a.mysite.com")).toEqual(["_3f1c9a.", "mysite.com"]);
    expect(hostSegments("localhost")).toEqual(["localhost"]);
    expect(hostSegments("launch-notes.indigo-hq.com").join("")).toBe("launch-notes.indigo-hq.com");
  });

  it("reads the company's own price and never turns a bad read into included", () => {
    expect(companyDomainPriceFrom({ basis: "paid", monthlyPriceUsd: 20, cardOnFile: true })).toEqual({ basis: "paid", monthlyPriceUsd: 20, cardOnFile: true });
    expect(companyDomainPriceFrom({ basis: "paid", monthlyPriceUsd: 0 })).toEqual({ basis: "paid", monthlyPriceUsd: 0 });
    expect(companyDomainPriceFrom({ basis: "enterprise", monthlyPriceUsd: 0 })).toEqual({ basis: "enterprise", monthlyPriceUsd: 0 });
    expect(companyDomainPriceFrom({ basis: "comped", monthlyPriceUsd: 0 })).toEqual({ basis: "comped", monthlyPriceUsd: 0 });
    expect(companyDomainPriceFrom({ basis: "not_enabled", monthlyPriceUsd: null })).toEqual({ basis: "not_enabled", monthlyPriceUsd: null });
    // Malformed or unknown: no company price, so the catalog price shows.
    expect(companyDomainPriceFrom({ basis: "paid" })).toBeNull();
    expect(companyDomainPriceFrom({ basis: "paid", monthlyPriceUsd: -1 })).toBeNull();
    expect(companyDomainPriceFrom({ basis: "free", monthlyPriceUsd: 0 })).toBeNull();
    expect(companyDomainPriceFrom({ error: { code: "NOT_FOUND" } })).toBeNull();
    expect(companyDomainPriceFrom(null)).toBeNull();
  });

  it("words the price line for each basis, and the catalog price when the company price is unknown", () => {
    const catalog = { standardUsd: 20, premiumUsd: 500 };
    expect(domainPriceLine(null, catalog, "Acme")).toBe("$20/month for this deployment, billed to the company. Remove it any time to stop the charge.");
    expect(domainPriceLine({ basis: "enterprise", monthlyPriceUsd: 0 }, catalog, "Acme")).toBe("Custom domains are included in Acme's enterprise plan. Nothing is charged.");
    expect(domainPriceLine({ basis: "comped", monthlyPriceUsd: 0 }, catalog, "Acme")).toBe("Acme is not charged for custom domains.");
    // A billing override of 0 on the paid path (domain-demo-test) is not charged either.
    expect(domainPriceLine({ basis: "paid", monthlyPriceUsd: 0 }, catalog, "Domain Demo")).toBe("Domain Demo is not charged for custom domains.");
    expect(domainPriceLine({ basis: "paid", monthlyPriceUsd: 12.5, cardOnFile: true }, catalog, "Acme")).toBe(
      "It adds $12.50/month to Acme's bill. The card on file is charged; no card form is needed.",
    );
    expect(domainPriceLine({ basis: "paid", monthlyPriceUsd: 20, cardOnFile: false }, catalog, "Acme")).toBe(
      "It adds $20/month to Acme's bill. Acme has no card on file, so adding stops at a page to add one.",
    );
    expect(domainPriceLine({ basis: "paid", monthlyPriceUsd: 20 }, catalog, "")).toBe("It adds $20/month to the company's bill. Remove it any time to stop the charge.");
    expect(domainPriceLine({ basis: "not_enabled", monthlyPriceUsd: null }, catalog, "Acme")).toContain("not available for Acme");
    expect(domainMonthlyUsd(null, catalog)).toBe(20);
    expect(domainMonthlyUsd({ basis: "not_enabled", monthlyPriceUsd: null }, catalog)).toBe(20);
    expect(domainMonthlyUsd({ basis: "paid", monthlyPriceUsd: 7 }, catalog)).toBe(7);
  });

  it("names the first live custom domain as the deployment's address", () => {
    expect(liveCustomDomainUrl([{ domain: "yousufkalim.com", state: "validated" }])).toBe("https://yousufkalim.com");
    expect(liveCustomDomainUrl([{ domain: "yousufkalim.com", state: "pending" }])).toBeNull();
    expect(liveCustomDomainUrl([])).toBeNull();
  });

  it("labels the certificate and routing records and rebuilds routing when missing", () => {
    const records = dnsRecordsFor("app.example.com", "launch-notes.indigo-hq.com", [
      { type: "CNAME", name: "_a.app.example.com.", value: "_b.acm-validations.aws." },
    ]);
    expect(records).toEqual([
      { type: "CNAME", name: "_a.app.example.com", value: "_b.acm-validations.aws", purpose: "ownership" },
      { type: "CNAME", name: "app.example.com", value: "launch-notes.indigo-hq.com", purpose: "routing" },
    ]);
  });

  it("keeps only Stripe billing links", () => {
    expect(trustedBillingUrl("https://billing.stripe.com/p/session/x")).toBe("https://billing.stripe.com/p/session/x");
    expect(trustedBillingUrl("https://someone.hq.computer/fake-billing")).toBeNull();
    expect(trustedBillingUrl("https://evil.example/x")).toBeNull();
    expect(trustedBillingUrl("http://billing.stripe.com/x")).toBeNull();
    expect(trustedBillingUrl("https://user:pw@billing.stripe.com/x")).toBeNull();
  });

  it("maps every refusal to plain copy and never echoes server text", () => {
    const copy = (status: number, code: string) => domainErrorCopy(new DomainRequestError(status, code, "raw server text", null));
    expect(copy(402, "PAYMENT_METHOD_REQUIRED").kind).toBe("card");
    expect(copy(403, "PAID_PLAN_REQUIRED").kind).toBe("not-eligible");
    expect(copy(403, "BILLING_ADMIN_REQUIRED").kind).toBe("admin");
    expect(copy(403, "DOMAIN_NOT_ENTITLED").kind).toBe("not-eligible");
    expect(copy(400, "DOMAIN_RESERVED").kind).toBe("reserved");
    expect(copy(409, "DOMAIN_CROSS_TENANT").kind).toBe("taken");
    expect(copy(503, "BILLING_UNAVAILABLE").kind).toBe("billing-down");
    expect(copy(502, "DOMAIN_PROVISIONING_FAILED").message).not.toContain("raw server text");
    expect(domainErrorCopy(new Error("auth: no token")).kind).toBe("signed-out");
  });

  it("lets owners and admins manage domains", () => {
    expect(canManageDomains("Owner")).toBe(true);
    expect(canManageDomains("admin")).toBe(true);
    expect(canManageDomains("Member")).toBe(false);
    expect(canManageDomains(null)).toBe(false);
  });

  it("retries a passing list failure, but never a refusal or sign-out", async () => {
    const flaky = { list: vi.fn().mockRejectedValueOnce(new DomainRequestError(503, "", "", null)).mockResolvedValueOnce([]) };
    await expect(listWithRetry(flaky, "app_1", [0, 0])).resolves.toEqual([]);
    expect(flaky.list).toHaveBeenCalledTimes(2);

    const refused = { list: vi.fn().mockRejectedValue(new DomainRequestError(404, "NOT_FOUND", "", null)) };
    await expect(listWithRetry(refused, "app_1", [0, 0])).rejects.toBeInstanceOf(DomainRequestError);
    expect(refused.list).toHaveBeenCalledTimes(1);

    const down = { list: vi.fn().mockRejectedValue(new Error("deploy domain fetch: offline")) };
    await expect(listWithRetry(down, "app_1", [0, 0])).rejects.toThrow("offline");
    expect(down.list).toHaveBeenCalledTimes(3);

    expect(isRetryableReadError(new Error("auth: expired"))).toBe(false);
  });
});
