// @vitest-environment happy-dom
//
// Core menu "Usage this month" panel: states, labels and the billing buttons.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import CoreUsagePanel from "./CoreUsagePanel.svelte";
import CoreUsagePanelSwitchProbe from "./CoreUsagePanelSwitchProbe.test.svelte";
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
    // An admin can't read whether a card is on file, so the label covers both.
    expect(q("core-usage-billing")?.textContent).toContain("Add or update card");
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

  it("a paused trial shows the reason and Add a card to resume instead of a bare red bar", async () => {
    const endsAt = new Date(Date.now() + 5.5 * DAY).toISOString();
    const src = source({
      getBillingSummary: vi.fn(async () =>
        ok({
          pricingPlan: "usage-only",
          usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 50000, allowanceCents: 1000, capReached: true, pauseReason: "usage_trial_cap", syncPaused: true },
        }),
      ),
    });
    await render(src);
    expect(q("core-usage-bar")?.dataset.tone).toBe("at");
    expect(q("core-usage-notice")?.dataset.kind).toBe("paused-trial-cap");
    expect(q("core-usage-notice")?.textContent).toMatch(/^Cloud sync is paused: the trial's \$500\.00 of usage is used up\./);
    expect(q("core-usage-notice")?.getAttribute("role")).toBe("status");
    expect(q("core-usage-billing")?.textContent).toContain("Add a card to resume");
  });

  it("a pause for a card after the included usage says so", async () => {
    await render(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", allowanceCents: 1000, cardRequired: true, pauseReason: "usage_card_required", syncPaused: true } }),
        ),
        getUsageStatement: vi.fn(async () => ok({ ...STATEMENT, usageCents: 1000 })),
      }),
    );
    expect(q("core-usage-notice")?.dataset.kind).toBe("paused-card-required");
    expect(q("core-usage-notice")?.textContent).toContain("Add a card to resume");
    expect(q("core-usage-billing")?.textContent).toContain("Add a card to resume");
  });

  it("a card prompt that does not pause offers Add a card", async () => {
    await render(
      source({
        getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", allowanceCents: 1000, cardRequired: true } })),
      }),
    );
    expect(q("core-usage-notice")?.dataset.kind).toBe("card-required");
    expect(q("core-usage-notice")?.textContent).not.toContain("paused");
    expect(q("core-usage-billing")?.textContent).toContain("Add a card");
  });

  it("cap reached without a pause shows its own reason", async () => {
    const endsAt = new Date(Date.now() + 5.5 * DAY).toISOString();
    await render(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 50000, capReached: true, syncPaused: false } }),
        ),
      }),
    );
    expect(q("core-usage-notice")?.dataset.kind).toBe("cap-reached");
  });

  it("an unpaused company shows no notice", async () => {
    await render(source());
    expect(q("core-usage-notice")).toBeNull();
  });

  it("marks trial usage as a minimum when some meters are unread", async () => {
    const endsAt = new Date(Date.now() + 5.5 * DAY).toISOString();
    await render(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 1000, unknownMeters: ["storage_bytes"] } }),
        ),
      }),
    );
    expect(q("core-usage-used")?.textContent).toBe("At least $10.00 of $500.00 trial usage");
    expect(q("core-usage-partial")).not.toBeNull();
  });

  it("an admin's note does not promise the billing button works", async () => {
    await render(source(), vi.fn(), { role: "admin" });
    expect(q("core-usage-owner-only")?.textContent).toBe("Only a company owner can see usage. If Add or update card doesn't open for you, ask an owner.");
  });

  it("a slow failing read that is unmounted mid-retry never updates the panel", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source({ getBillingSummary: vi.fn(async () => fail("http-500")) });
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CoreUsagePanel, {
      target: host,
      props: { source: src as never, companyUid: "cmp_northwind", companyName: "Northwind", retryDelays: [20, 20] },
    });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await unmount(component);
    component = null;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Unmount cancels the read: no retry runs after the first try.
    expect(src.getBillingSummary).toHaveBeenCalledTimes(1);
  });

  it("a failed refresh keeps the last numbers and says when they were read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source();
    await render(src, vi.fn(), { refreshMs: 0 });
    expect(q("core-usage-stale")).toBeNull();
    src.getBillingSummary.mockResolvedValue(fail("http-500") as never);
    // A focus after Stripe re-reads; make it fail.
    q("core-usage-billing")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.dispatchEvent(new Event("focus"));
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(q("core-usage")?.dataset.state).toBe("ready");
    expect(q("core-usage-used")?.textContent).toBe("$8.00 of $10.00 free");
    expect(q("core-usage-stale")?.textContent).toMatch(/^Couldn't refresh\. Showing usage from \d{1,2}:\d{2} [AP]M\.$/);
  });

  it("switching to another company with the same name never keeps the first company's numbers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source();
    host = document.createElement("div");
    document.body.append(host);
    component = mount(CoreUsagePanelSwitchProbe, {
      target: host,
      props: { source: src as never, first: "cmp_northwind", second: "cmp_other", name: "Northwind" },
    });
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(q("core-usage-used")?.textContent).toBe("$8.00 of $10.00 free");
    // The second company's read fails; the first company's numbers must not stay up.
    src.getBillingSummary.mockResolvedValue(fail("http-500") as never);
    q("probe-switch")!.click();
    flushSync();
    expect(q("core-usage")?.dataset.state).toBe("loading");
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(src.getBillingSummary).toHaveBeenLastCalledWith("cmp_other");
    expect(q("core-usage")?.dataset.state).toBe("unavailable");
    expect(host.textContent).not.toContain("$8.00");
    expect(q("core-usage-stale")).toBeNull();
  });


  describe("multi-company owners and the personal account", () => {
    const ACCOUNTS = [
      { kind: "company" as const, uid: "cmp_amass", name: "Amass", role: "admin" },
      { kind: "company" as const, uid: "cmp_northwind", name: "Northwind", role: "owner" },
      { kind: "personal" as const, uid: null, name: "Personal", role: null },
    ];
    const PERSON_STATEMENT = { ...STATEMENT, usageCents: 340, lines: [{ key: "member-sync", status: "measured", billed: true, costCents: 340 }] };

    function multiSource(overrides: Record<string, unknown> = {}) {
      return {
        ...source(),
        getPersonalBillingSummary: vi.fn(async () => ok({ cardOnFile: false, personalUsage: { allowanceCents: 1000, usedCents: 340, cardOnFile: false } })),
        getPersonalUsageStatement: vi.fn(async () => ok(PERSON_STATEMENT)),
        createPersonalBillingCheckoutSession: vi.fn(async () => ok({ url: "https://checkout.stripe.com/c/pay/cs_person" })),
        createPersonalBillingPortalSession: vi.fn(async () => ok({ url: "https://billing.stripe.com/p/session/person" })),
        ...overrides,
      } as ReturnType<typeof source> & {
        getPersonalBillingSummary: ReturnType<typeof vi.fn>;
        getPersonalUsageStatement: ReturnType<typeof vi.fn>;
        createPersonalBillingCheckoutSession: ReturnType<typeof vi.fn>;
        createPersonalBillingPortalSession: ReturnType<typeof vi.fn>;
      };
    }

    it("defaults to the personal account when that is the default, reading the person routes", async () => {
      const src = multiSource();
      await render(src, vi.fn(), { account: ACCOUNTS[2], accounts: ACCOUNTS });
      expect(q("core-usage")?.dataset.state).toBe("ready");
      expect(q("core-usage-company")?.textContent).toBe("Personal");
      expect(q("core-usage-used")?.textContent).toBe("$3.40 of $10.00 free");
      // The meter and the Personal row share one read.
      expect(src.getPersonalBillingSummary).toHaveBeenCalledTimes(1);
      // The admin company is never read with the owner-gated routes.
      expect(src.getBillingSummary).not.toHaveBeenCalledWith("cmp_amass");
    });

    it("a single account shows no account list", async () => {
      await render(source(), vi.fn(), { account: ACCOUNTS[1], accounts: [ACCOUNTS[1]] });
      expect(q("core-usage-accounts")).toBeNull();
      expect(q("core-usage-top-label")).toBeNull();
    });

    it("Set up billing on the personal account opens personal card capture", async () => {
      const src = multiSource();
      const open = await render(src, vi.fn(), { account: ACCOUNTS[2], accounts: ACCOUNTS });
      expect(q("core-usage-billing")?.textContent).toContain("Set up billing");
      q("core-usage-billing")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(src.createPersonalBillingCheckoutSession).toHaveBeenCalledTimes(1);
      expect(src.createBillingCheckoutSession).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_person");
    });

    it("a personal card on file opens the personal portal", async () => {
      const src = multiSource({
        getPersonalBillingSummary: vi.fn(async () => ok({ cardOnFile: true, personalUsage: { allowanceCents: 1000, usedCents: 340, cardOnFile: true } })),
      });
      const open = await render(src, vi.fn(), { account: ACCOUNTS[2], accounts: ACCOUNTS });
      expect(q("core-usage-billing")?.textContent).toContain("Manage billing");
      q("core-usage-billing")!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(src.createPersonalBillingPortalSession).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith("https://billing.stripe.com/p/session/person");
    });

    it("Usage details remembers the account so Settings > Usage opens on it", async () => {
      const { preferredUsageAccount, setPreferredUsageAccount } = await import("./core-usage-model");
      setPreferredUsageAccount(null);
      const onopenusage = vi.fn();
      await render(multiSource(), vi.fn(), { account: ACCOUNTS[2], accounts: ACCOUNTS, onopenusage });
      q("core-usage-details")!.click();
      expect(onopenusage).toHaveBeenCalledTimes(1);
      expect(preferredUsageAccount()).toBe("personal");
      setPreferredUsageAccount(null);
    });

    describe("Personal plus the top 5 companies by usage", () => {
      // Seven owner companies plus one admin company, so the cutoff shows.
      const TOTALS: Record<string, number> = {
        cmp_a: 120, cmp_b: 4500, cmp_c: 800, cmp_d: 2600, cmp_e: 30, cmp_f: 990, cmp_g: 1500,
      };
      const NAMES: Record<string, string> = {
        cmp_a: "Alder", cmp_b: "Birch", cmp_c: "Cedar", cmp_d: "Dogwood", cmp_e: "Elm", cmp_f: "Fir", cmp_g: "Ginkgo",
      };
      const MANY = [
        { kind: "company" as const, uid: "cmp_admin", name: "Aspen", role: "admin" },
        ...Object.keys(TOTALS).map((uid) => ({ kind: "company" as const, uid, name: NAMES[uid], role: "owner" })),
        ACCOUNTS[2],
      ];
      const settle = async () => {
        for (let round = 0; round < 3; round += 1) {
          flushSync();
          for (let i = 0; i < 5; i += 1) await tick();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        flushSync();
      };
      const rowsText = () =>
        [...host.querySelectorAll('[data-testid="core-usage-account"]')].map((r) => r.textContent?.replace(/\s+/g, " ").trim());
      const manySource = (overrides: Record<string, unknown> = {}) =>
        multiSource({
          getUsageStatement: vi.fn(async (uid: string) => ok({ ...STATEMENT, usageCents: TOTALS[uid] ?? 0 })),
          ...overrides,
        });

      it("lists Personal first, then the five companies with the most usage, highest first", async () => {
        const src = manySource();
        await render(src, vi.fn(), { account: MANY[2], accounts: MANY, onopenusage: vi.fn() });
        await settle();
        expect(q("core-usage-top-label")?.textContent).toBe("Top 5 by usage this month");
        // The admin company is never read with the owner-gated routes.
        expect(src.getBillingSummary).not.toHaveBeenCalledWith("cmp_admin");
        expect(q("core-usage-accounts")?.dataset.ranked).toBe("true");
        expect(rowsText()).toEqual([
          "Personal Your account $3.40",
          "Birch Owner $45.00",
          "Dogwood Owner $26.00",
          "Ginkgo Owner $15.00",
          "Fir Owner $9.90",
          "Cedar Owner $8.00",
        ]);
      });

      it("companies without a readable total go after the ranked ones", async () => {
        const few = [MANY[0], MANY[1], MANY[2], ACCOUNTS[2]];
        await render(manySource(), vi.fn(), { account: MANY[2], accounts: few });
        await settle();
        expect(rowsText()).toEqual([
          "Personal Your account $3.40",
          "Birch Owner $45.00",
          "Alder Owner $1.20",
          "Aspen Admin Owner only",
        ]);
      });

      it("a row switches the meter in place and the list stays", async () => {
        await render(manySource(), vi.fn(), { account: MANY[2], accounts: MANY });
        await settle();
        (host.querySelector('[data-key="personal"]') as HTMLElement).click();
        await settle();
        expect(q("core-usage-company")?.textContent).toBe("Personal");
        expect(q("core-usage-used")?.textContent).toBe("$3.40 of $10.00 free");
        expect(q("core-usage-accounts")).not.toBeNull();
        expect((host.querySelector('[data-key="personal"]') as HTMLElement).getAttribute("aria-selected")).toBe("true");
      });

      it("All usage in Settings opens Settings > Usage on the shown account and counts the hidden companies", async () => {
        const { preferredUsageAccount, setPreferredUsageAccount } = await import("./core-usage-model");
        setPreferredUsageAccount(null);
        const onopenusage = vi.fn();
        await render(manySource(), vi.fn(), { account: MANY[2], accounts: MANY, onopenusage });
        await settle();
        expect(q("core-usage-all")?.textContent).toBe("All usage in Settings (3 more)");
        q("core-usage-all")!.click();
        expect(onopenusage).toHaveBeenCalledTimes(1);
        expect(preferredUsageAccount()).toBe("cmp_b");
        setPreferredUsageAccount(null);
      });

      it("keeps name order while totals are still loading, so rows don't jump", async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => (release = resolve));
        await render(
          manySource({
            getUsageStatement: vi.fn(async (uid: string) => {
              if (uid === "cmp_e") await gate;
              return ok({ ...STATEMENT, usageCents: TOTALS[uid] ?? 0 });
            }),
          }),
          vi.fn(),
          { account: MANY[2], accounts: MANY },
        );
        await settle();
        expect(q("core-usage-accounts")?.dataset.ranked).toBe("false");
        expect(rowsText().slice(1).map((r) => r?.split(" ")[0])).toEqual(["Aspen", "Alder", "Birch", "Cedar", "Dogwood"]);
        release();
        await settle();
        expect(q("core-usage-accounts")?.dataset.ranked).toBe("true");
      });
    });

    it("a personal account not on the usage plan says so", async () => {
      await render(multiSource({ getPersonalBillingSummary: vi.fn(async () => ok({ cardOnFile: false })) }), vi.fn(), {
        account: ACCOUNTS[2],
        accounts: ACCOUNTS,
      });
      expect(q("core-usage-personal-none")).not.toBeNull();
    });
  });
});
