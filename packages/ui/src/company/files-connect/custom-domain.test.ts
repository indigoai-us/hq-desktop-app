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
  isApexDomain,
  normalizeDomainInput,
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

  it("tells root domains from subdomains", () => {
    expect(isApexDomain("example.com")).toBe(true);
    expect(isApexDomain("example.co.uk")).toBe(true);
    expect(isApexDomain("app.example.com")).toBe(false);
    expect(isApexDomain("demo.yousufkalim.com")).toBe(false);
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
