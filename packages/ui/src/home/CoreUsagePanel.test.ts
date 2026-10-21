// @vitest-environment happy-dom
//
// Core menu "Usage this month" panel: states, labels and the billing buttons.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import CoreUsagePanel from "./CoreUsagePanel.svelte";
import { COMPARE_PLANS_URL, __resetCoreUsageCacheForTests } from "./core-usage-model";

const ok = (value: unknown) => ({ ok: true as const, value });
const fail = (code: string) => ({ ok: false as const, reason: "error" as const, code, message: code });

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  __resetCoreUsageCacheForTests();
  vi.restoreAllMocks();
});

const STATEMENT = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  complete: true,
  allowanceCents: 1000,
  usageCents: 800,
  lines: [
    { key: "agent-run", status: "measured", billed: true, costCents: 510 },
    { key: "member-sync", status: "unavailable", billed: true, costCents: null },
  ],
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: false } })),
    getUsageStatement: vi.fn(async () => ok(STATEMENT)),
    createBillingPortalSession: vi.fn(async () => ok({ url: "https://billing.stripe.com/p/session/test" })),
    createBillingCheckoutSession: vi.fn(async () => ok({ url: "https://checkout.stripe.com/c/pay/cs_test" })),
    ...overrides,
  };
}

async function render(
  src: ReturnType<typeof source>,
  onopenurl = vi.fn(),
  extra: { companyUid?: string | null; role?: string | null } = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(CoreUsagePanel, {
    target: host,
    props: { source: src as never, companyUid: "cmp_northwind", companyName: "Northwind", onopenurl, ...extra },
  });
  flushSync();
  for (let i = 0; i < 5; i += 1) await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  return onopenurl;
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("CoreUsagePanel Sync link (US-016)", () => {
  it("opens Sync settings in one click when the host has a Sync section", async () => {
    const onopensync = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CoreUsagePanel, {
      target: host,
      props: { source: source() as never, companyUid: null, companyName: "Northwind", onopensync },
    });
    flushSync();
    q("core-usage-sync-settings")!.click();
    expect(onopensync).toHaveBeenCalledTimes(1);
  });

  it("hides the link without a Sync section", async () => {
    await render(source());
    expect(q("core-usage-sync-settings")).toBeNull();
  });
});

describe("CoreUsagePanel", () => {
  it("renders the company, plan, bar, totals and grouped rows", async () => {
    await render(source());
    expect(q("core-usage")?.dataset.state).toBe("ready");
    expect(q("core-usage-company")?.querySelector('[data-testid="company-label"]')?.textContent).toContain("Northwind");
    expect(q("core-usage-plan")?.textContent).toBe("Free plan");
    // One meter is unreported, so the headline is a floor.
    expect(q("core-usage-used")?.textContent).toBe("At least $8.00 of $10.00 free");
    expect(q("core-usage-reset")?.textContent).toBe("Resets Nov 1");
    const fill = host.querySelector(".core-usage-fill") as HTMLElement;
    expect(fill.getAttribute("style")).toContain("--fill: 0.8");
    const rows = [...host.querySelectorAll('[data-testid="core-usage-row"]')].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toEqual(["Assistant and bots $5.10", "Storage and sync Not reported"]);
    expect(q("core-usage-billing")?.textContent).toContain("Set up billing");
  });

  it("Set up billing opens the Stripe card-capture checkout for this company", async () => {
    const src = source();
    const open = await render(src);
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(src.createBillingCheckoutSession).toHaveBeenCalledWith("cmp_northwind");
    expect(open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test");
  });

  it("never opens a checkout URL off the Stripe checkout host", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source({ createBillingCheckoutSession: vi.fn(async () => ok({ url: "https://hq.computer/billing" })) });
    const open = await render(src);
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(open).not.toHaveBeenCalled();
    expect(q("core-usage-billing-hint")).not.toBeNull();
  });

  it("a company with a card shows Manage billing and opens the portal", async () => {
    const src = source({
      getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: true } })),
    });
    const open = await render(src);
    expect(q("core-usage-billing")?.textContent).toContain("Manage billing");
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(src.createBillingPortalSession).toHaveBeenCalledWith("cmp_northwind");
    expect(open).toHaveBeenCalledWith("https://billing.stripe.com/p/session/test");
  });

  it("Compare plans opens the public pricing page", async () => {
    const open = await render(source());
    q("core-usage-compare")!.click();
    expect(open).toHaveBeenCalledWith(COMPARE_PLANS_URL);
    expect(COMPARE_PLANS_URL).toBe("https://hqforwork.com/pricing");
  });

  it("a non-owner sees a quiet note and no numbers or buttons", async () => {
    await render(source({ getBillingSummary: vi.fn(async () => fail("FORBIDDEN")) }));
    expect(q("core-usage")?.dataset.state).toBe("owner-only");
    expect(q("core-usage-owner-only")).not.toBeNull();
    expect(q("core-usage-used")).toBeNull();
    expect(q("core-usage-billing")).toBeNull();
  });

  it("a local company says it has no usage and reads nothing", async () => {
    const src = source();
    await render(src, vi.fn(), { companyUid: null });
    expect(q("core-usage")?.dataset.state).toBe("no-usage");
    expect(q("core-usage-none")?.textContent).toContain("No usage for this company");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
    expect(q("core-usage-used")).toBeNull();
    expect(q("core-usage-billing")).toBeNull();
  });

  it("a member the roster knows is not an owner gets the note at once, with no read", async () => {
    const src = source();
    await render(src, vi.fn(), { role: "member" });
    expect(q("core-usage")?.dataset.state).toBe("owner-only");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
  });

  it("marks a partial total on the headline and explains it", async () => {
    await render(source({ getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, complete: false })) }));
    expect(q("core-usage-used")?.textContent).toBe("At least $8.00 of $10.00 free");
    expect(q("core-usage-used")?.dataset.partial).toBe("true");
    expect(q("core-usage-partial")).not.toBeNull();
  });

  it("styles the bar once usage passes the allowance", async () => {
    await render(source({ getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, usageCents: 1420 })) }));
    expect(host.querySelector(".core-usage-fill")?.classList.contains("over")).toBe(true);
  });

  it("re-reads billing when the window regains focus after Stripe opens", async () => {
    const src = source();
    await render(src);
    expect(src.getBillingSummary).toHaveBeenCalledTimes(1);
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    src.getBillingSummary.mockResolvedValueOnce(ok({ pricingPlan: "usage-only", usageTrial: { status: "active", cardOnFile: true } }));
    window.dispatchEvent(new Event("focus"));
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(src.getBillingSummary).toHaveBeenCalledTimes(2);
    expect(q("core-usage-billing")?.textContent).toContain("Manage billing");
    expect(q("core-usage-plan")?.textContent).toBe("Pay as you go");
  });

  it("a failed lookup says unavailable and never shows $0", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await render(source({ getBillingSummary: vi.fn(async () => fail("http-500")) }));
    expect(q("core-usage")?.dataset.state).toBe("unavailable");
    expect(host.textContent).not.toContain("$0.00");
  });
});
