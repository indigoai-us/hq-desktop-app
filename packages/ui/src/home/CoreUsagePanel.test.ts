// @vitest-environment happy-dom
//
// Core menu "Usage this month" panel: states, labels and the billing buttons.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import CoreUsagePanel from "./CoreUsagePanel.svelte";
import { __resetCoreUsageCacheForTests } from "./core-usage-model";

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
    { key: "agent-run", status: "measured", billed: true, costCents: 410 },
    { key: "hq-mcp-call", status: "measured", billed: true, costCents: 60 },
    { key: "integration-call", status: "measured", billed: true, costCents: 40 },
    { key: "member-sync", status: "measured", billed: true, costCents: 190 },
    { key: "storage", status: "measured", billed: true, costCents: 50 },
    { key: "secret", status: "measured", billed: true, costCents: 50 },
    { key: "vault", status: "measured", billed: true, costCents: 0 },
  ],
};

const DAY = 86_400_000;

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
  extra: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(CoreUsagePanel, {
    target: host,
    props: { source: src as never, companyUid: "cmp_northwind", companyName: "Northwind", onopenurl, retryDelays: [], ...extra },
  });
  flushSync();
  for (let i = 0; i < 5; i += 1) await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  return onopenurl;
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("CoreUsagePanel", () => {
  it("renders the company, Usage plan, bar, totals and the three groups", async () => {
    await render(source());
    expect(q("core-usage")?.dataset.state).toBe("ready");
    expect(q("core-usage-company")?.querySelector('[data-testid="company-label"]')?.textContent).toContain("Northwind");
    expect(q("core-usage-plan")?.textContent).toBe("Usage plan");
    expect(q("core-usage-label")?.textContent).toBe("Usage this month");
    expect(q("core-usage-used")?.textContent).toBe("$8.00 of $10.00 free");
    expect(q("core-usage-reset")?.textContent).toBe("Resets Nov 1");
    const fill = host.querySelector(".core-usage-fill") as HTMLElement;
    expect(fill.getAttribute("style")).toContain("--fill: 0.8");
    const rows = [...host.querySelectorAll('[data-testid="core-usage-row"]')].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
    expect(rows).toEqual(["Agents and AI $5.10", "Sync $1.90", "Storage and vaults $1.00"]);
    expect(q("core-usage-billing")?.textContent).toContain("Set up billing");
    expect(q("core-usage-details")?.textContent).toContain("Usage details");
    expect(q("core-usage-compare")).toBeNull();
  });

  it("the bar is neutral under 80%, amber from 80%, red at the allowance", async () => {
    await render(source({ getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, usageCents: 500, lines: [] })) }));
    expect(q("core-usage-bar")?.dataset.tone).toBe("ok");
    await unmount(component!);
    component = null;
    host.remove();
    __resetCoreUsageCacheForTests();
    await render(source());
    expect(q("core-usage-bar")?.dataset.tone).toBe("near");
    await unmount(component!);
    component = null;
    host.remove();
    __resetCoreUsageCacheForTests();
    await render(source({ getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, usageCents: 1000 })) }));
    expect(q("core-usage-bar")?.dataset.tone).toBe("at");
  });

  it("during the trial shows days left and trial usage against the cap instead of the $10 line", async () => {
    const endsAt = new Date(Date.now() + 11.5 * DAY).toISOString();
    const src = source({
      getBillingSummary: vi.fn(async () =>
        ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 42000, cardOnFile: false } }),
      ),
    });
    await render(src);
    expect(q("core-usage-plan")?.textContent).toBe("Trial, 12 days left");
    expect(q("core-usage-label")?.textContent).toBe("Trial usage");
    expect(q("core-usage-used")?.textContent).toBe("$420.00 of $500.00 trial usage");
    expect(q("core-usage-used")?.textContent).not.toContain("$10.00");
    expect(q("core-usage-reset")?.textContent).toMatch(/^Trial ends /);
    expect(q("core-usage-bar")?.dataset.mode).toBe("trial");
    expect(q("core-usage-bar")?.dataset.tone).toBe("near");
    expect(q("core-usage-rows-note")).not.toBeNull();
    // The trial meter comes from the summary; no statement read is needed.
    expect(src.getUsageStatement).not.toHaveBeenCalled();
  });

  it("Set up billing opens the Stripe card-capture checkout for this company", async () => {
    const src = source();
    const open = await render(src);
    q("core-usage-billing")!.click();
    flushSync();
    // Activation is acknowledged at once and repeat clicks are blocked.
    expect(q("core-usage-billing")?.hasAttribute("disabled")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(src.createBillingCheckoutSession).toHaveBeenCalledTimes(1);
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
      getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true } })),
    });
    const open = await render(src);
    expect(q("core-usage-billing")?.textContent).toContain("Manage billing");
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(src.createBillingPortalSession).toHaveBeenCalledWith("cmp_northwind");
    expect(open).toHaveBeenCalledWith("https://billing.stripe.com/p/session/test");
  });

  it("Usage details opens Settings > Usage and Turn off sync opens the Sync section", async () => {
    const onopenusage = vi.fn();
    const onopensync = vi.fn();
    await render(source(), vi.fn(), { onopenusage, onopensync });
    q("core-usage-details")!.click();
    expect(onopenusage).toHaveBeenCalledTimes(1);
    q("core-usage-sync-off")!.click();
    expect(onopensync).toHaveBeenCalledTimes(1);
    expect(q("core-usage-sync-off")?.textContent).toBe("Turn off sync");
  });

  it("an owner-only answer with an unknown role shows a note and no numbers or buttons", async () => {
    await render(source({ getBillingSummary: vi.fn(async () => fail("FORBIDDEN")) }));
    expect(q("core-usage")?.dataset.state).toBe("owner-only");
    expect(q("core-usage-owner-only")).not.toBeNull();
    expect(q("core-usage-used")).toBeNull();
    expect(q("core-usage-billing")).toBeNull();
  });

  it("an admin sees no usage numbers but can set up billing", async () => {
    const src = source();
    const open = await render(src, vi.fn(), { role: "admin" });
    expect(q("core-usage")?.dataset.state).toBe("owner-only");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
    expect(q("core-usage-used")).toBeNull();
    expect(q("core-usage-billing")?.textContent).toContain("Set up billing");
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(src.createBillingCheckoutSession).toHaveBeenCalledWith("cmp_northwind");
    expect(open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test");
  });

  it("a member is told who to ask, with no read and no billing button", async () => {
    const src = source();
    await render(src, vi.fn(), { role: "member" });
    expect(q("core-usage")?.dataset.state).toBe("owner-only");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
    expect(q("core-usage-owner-only")?.textContent).toContain("Ask an owner or admin of Northwind to set up billing");
    expect(q("core-usage-billing")).toBeNull();
  });

  it("a local company says it has no usage and reads nothing", async () => {
    const src = source();
    await render(src, vi.fn(), { companyUid: null, onopensync: vi.fn() });
    expect(q("core-usage")?.dataset.state).toBe("no-usage");
    expect(q("core-usage-none")?.textContent).toContain("No usage for this company");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
    expect(q("core-usage-used")).toBeNull();
    expect(q("core-usage-billing")).toBeNull();
    expect(q("core-usage-sync-off")).toBeNull();
  });

  it("marks a partial total on the headline and explains it", async () => {
    await render(source({ getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, complete: false })) }));
    expect(q("core-usage-used")?.textContent).toBe("At least $8.00 of $10.00 free");
    expect(q("core-usage-used")?.dataset.partial).toBe("true");
    expect(q("core-usage-partial")).not.toBeNull();
  });

  it("re-reads billing when the window regains focus after Stripe opens", async () => {
    const src = source();
    await render(src);
    expect(src.getBillingSummary).toHaveBeenCalledTimes(1);
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    src.getBillingSummary.mockResolvedValueOnce(ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true } }));
    window.dispatchEvent(new Event("focus"));
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(src.getBillingSummary).toHaveBeenCalledTimes(2);
    expect(q("core-usage-billing")?.textContent).toContain("Manage billing");
    expect(q("core-usage-plan")?.textContent).toBe("Usage plan");
  });

  it("re-reads on the refresh interval while open", async () => {
    vi.useFakeTimers();
    try {
      const src = source();
      host = document.createElement("div");
      document.body.append(host);
      component = mount(CoreUsagePanel, {
        target: host,
        props: { source: src as never, companyUid: "cmp_northwind", companyName: "Northwind", retryDelays: [], refreshMs: 180_000 },
      });
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(src.getBillingSummary).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(179_000);
      expect(src.getBillingSummary).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(src.getBillingSummary).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed lookup says unavailable, never shows $0 or server text, and Try again re-reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source({
      getBillingSummary: vi.fn(async () => ({ ok: false as const, reason: "error" as const, code: "http-500", message: '{"message":"Internal Server Error"}' })),
    });
    await render(src);
    expect(q("core-usage")?.dataset.state).toBe("unavailable");
    expect(host.textContent).not.toContain("$0.00");
    expect(host.textContent).not.toContain("Internal Server Error");
    expect(host.textContent).not.toContain("500");
    src.getBillingSummary.mockResolvedValueOnce(ok({ pricingPlan: "usage-only", usageTrial: { status: "ended" } }) as never);
    q("core-usage-retry")!.click();
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(src.getBillingSummary).toHaveBeenCalledTimes(2);
    expect(q("core-usage")?.dataset.state).toBe("ready");
  });
});
