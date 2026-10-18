import { describe, expect, it, vi } from "vitest";
import type { AdapterResult } from "@hq/platform";
import { approvedPortalUrl, billingPortalHint, openBillingPortal } from "./billing-portal.js";

const PORTAL = "https://billing.stripe.com/p/session/test_YWNjdF8x";

const fail = (code: string, message = "raw server text"): AdapterResult<{ url: string }> => ({
  ok: false,
  reason: "error",
  code,
  message,
});

const noSleep = async () => {};

describe("openBillingPortal (Manage payment)", () => {
  it("opens the URL the billing API minted for the company, not a constant", async () => {
    const createSession = vi.fn(async () => ({ ok: true as const, value: { url: PORTAL } }));
    const openExternal = vi.fn();
    const outcome = await openBillingPortal({ companyUid: "cmp_acme", createSession, openExternal, sleep: noSleep });
    expect(outcome).toEqual({ kind: "opened" });
    expect(createSession).toHaveBeenCalledWith("cmp_acme");
    expect(openExternal).toHaveBeenCalledWith(PORTAL);
    expect(openExternal).not.toHaveBeenCalledWith("https://billing.stripe.com/p/login/hq");
  });

  it("retries a transient failure with backoff, then opens", async () => {
    const createSession = vi
      .fn()
      .mockResolvedValueOnce(fail("http-503"))
      .mockResolvedValueOnce(fail("network"))
      .mockResolvedValueOnce({ ok: true, value: { url: PORTAL } });
    const sleep = vi.fn(noSleep);
    const openExternal = vi.fn();
    const outcome = await openBillingPortal({ companyUid: "cmp_acme", createSession, openExternal, sleep });
    expect(outcome).toEqual({ kind: "opened" });
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenCalledWith(PORTAL);
  });

  it("gives up after three tries with a retry outcome and opens nothing", async () => {
    const createSession = vi.fn(async () => fail("http-500"));
    const openExternal = vi.fn();
    const outcome = await openBillingPortal({ companyUid: "cmp_acme", createSession, openExternal, sleep: noSleep });
    expect(outcome).toEqual({ kind: "retry" });
    expect(createSession).toHaveBeenCalledTimes(3);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("stops at an owner handoff on 403 without retrying", async () => {
    const createSession = vi.fn(async () => fail("FORBIDDEN", "Requires owner role on this company"));
    const outcome = await openBillingPortal({ companyUid: "cmp_acme", createSession, openExternal: vi.fn(), sleep: noSleep });
    expect(outcome).toEqual({ kind: "owner-only" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("treats a mislinked Stripe customer (409) as a support case without retrying", async () => {
    const createSession = vi.fn(async () => fail("BILLING_CUSTOMER_CONFLICT"));
    const outcome = await openBillingPortal({ companyUid: "cmp_acme", createSession, openExternal: vi.fn(), sleep: noSleep });
    expect(outcome).toEqual({ kind: "needs-support" });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("never opens a URL that is not a billing.stripe.com https page", async () => {
    for (const url of ["https://evil.example/p/session/x", "http://billing.stripe.com/p/session/x", "https://checkout.stripe.com/c/pay/x", ""]) {
      const openExternal = vi.fn();
      const outcome = await openBillingPortal({
        companyUid: "cmp_acme",
        createSession: async () => ({ ok: true, value: { url } }),
        openExternal,
        sleep: noSleep,
      });
      expect(outcome).toEqual({ kind: "retry" });
      expect(openExternal).not.toHaveBeenCalled();
    }
    expect(approvedPortalUrl(PORTAL)).toBe(PORTAL);
  });

  it("hints are plain language with a next step and never echo server text", () => {
    const hints = [
      billingPortalHint({ kind: "owner-only" }, "Acme"),
      billingPortalHint({ kind: "needs-support" }, "Acme"),
      billingPortalHint({ kind: "retry" }, "Acme"),
    ];
    expect(hints).toEqual([
      "Only an owner of Acme can manage payment. Ask an owner to open it.",
      "Billing for Acme needs a fix on our side. Tap to retry, or contact support.",
      "Stripe didn't open. Tap to retry.",
    ]);
    for (const hint of hints) expect(hint).not.toMatch(/HTTP|\{|FORBIDDEN|raw server text/);
    expect(billingPortalHint({ kind: "opened" }, "Acme")).toBeNull();
    expect(billingPortalHint(null, "Acme")).toBeNull();
  });
});
