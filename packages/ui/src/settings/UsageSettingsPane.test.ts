// @vitest-environment happy-dom
//
// Settings > Usage (usage-only-pricing US-018), one line per account with an
// accordion detail (owner direction, Corey, 2026-10-19): the list, opening
// and closing lines, the detail, and Switch to usage pricing (hq-pro #5081).

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import UsageSettingsPane from "./UsageSettingsPane.svelte";
import UsageSettingsPaneAccountsProbe from "./UsageSettingsPaneAccountsProbe.test.svelte";
import { setPreferredUsageAccount } from "../home/core-usage-model";

const ok = (value: unknown) => ({ ok: true as const, value });
const fail = (code: string, message = code) => ({ ok: false as const, reason: "error" as const, code, message });

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  setPreferredUsageAccount(null);
  vi.restoreAllMocks();
});

const line = (key: string, displayName: string, unit: string, unitCents: number, costCents: number) => ({
  key, displayName, unit, unitCents, status: "measured", billed: true, units: costCents / unitCents, costCents,
});

function statement(usageCents: number) {
  return {
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    asOf: "2026-10-17",
    complete: true,
    allowanceCents: 1000,
    usageCents,
    allowanceLeftCents: Math.max(0, 1000 - usageCents),
    billCents: Math.max(0, usageCents - 1000),
    projectedBillCents: Math.max(0, usageCents * 2 - 1000),
    lines: [
      line("agent-run", "Agent run", "run", 5, Math.round(usageCents * 0.5)),
      line("integration-call", "Gateway call", "call", 5, Math.round(usageCents * 0.25)),
      line("member-sync", "Sync", "sync", 10, usageCents - Math.round(usageCents * 0.5) - Math.round(usageCents * 0.25)),
      line("storage", "Storage", "GB-month", 200, 0),
    ],
  };
}

const PRICING = {
  usage: {
    includedUsd: 10,
    trial: { days: 30, capUsd: 500 },
    meters: [
      { id: "member-sync", label: "Sync", unit: "sync", unitUsd: 0.1 },
      { id: "agent-run", label: "Agent run", unit: "run", unitUsd: 0.05 },
      { id: "integration-call", label: "Gateway call", unit: "call", unitUsd: 0.05 },
      { id: "storage", label: "Storage", unit: "GB-month", unitUsd: 2 },
    ],
    boxes: [{ size: "small", instanceType: "t3.small", monthlyUsd: 100 }],
  },
};

const TRIAL_ENDS = new Date(Date.now() + 11.5 * 86_400_000).toISOString();

// Fixture: Personal on Starter, Birch in its trial, Northwind on the usage
// plan with a spend limit, Cedar on an older paid plan, Dogwood on the older
// free plan, Aspen admin-only, Elm on the usage plan. Seven accounts.
const SUMMARIES: Record<string, unknown> = {
  cmp_birch: { pricingPlan: "usage-only", usageTrial: { status: "active", endsAt: TRIAL_ENDS, capCents: 50000, usedCents: 42000, cardOnFile: false } },
  cmp_northwind: { pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true }, defaultPaymentMethod: { present: true } },
  cmp_cedar: { pricingPlan: "current", plan: "team", subscriptionStatus: "active", defaultPaymentMethod: { present: true } },
  cmp_dogwood: { pricingPlan: "current", subscriptionStatus: null, defaultPaymentMethod: { present: true } },
  cmp_elm: { pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: false } },
};
const USAGE: Record<string, number> = { cmp_birch: 0, cmp_northwind: 800, cmp_elm: 120 };

const ACCOUNTS = [
  { kind: "company" as const, uid: "cmp_northwind", name: "Northwind", role: "owner" },
  { kind: "company" as const, uid: "cmp_aspen", name: "Aspen", role: "admin" },
  { kind: "company" as const, uid: "cmp_birch", name: "Birch", role: "owner" },
  { kind: "company" as const, uid: "cmp_cedar", name: "Cedar", role: "owner" },
  { kind: "company" as const, uid: "cmp_dogwood", name: "Dogwood", role: "owner" },
  { kind: "company" as const, uid: "cmp_elm", name: "Elm", role: "owner" },
  { kind: "personal" as const, uid: null, name: "Personal", role: null },
];

function source(overrides: Record<string, unknown> = {}) {
  return {
    getBillingSummary: vi.fn(async (uid: string) => (SUMMARIES[uid] ? ok(SUMMARIES[uid]) : fail("FORBIDDEN"))),
    getUsageStatement: vi.fn(async (uid: string) => ok(statement(USAGE[uid] ?? 0))),
    getPricing: vi.fn(async () => ok(PRICING)),
    getSpendLimit: vi.fn(async () => ok({ limitCents: 25000, custom: true, paused: false })),
    getPersonalBillingSummary: vi.fn(async () => ok({ cardOnFile: false, subscriptionStatus: null })),
    getPersonalUsageStatement: vi.fn(async () => ok(statement(0))),
    getPersonalSpendLimit: vi.fn(async () => ok({ limitCents: 10000, custom: false, paused: false })),
    getUsageSwitch: vi.fn(async () => ok({ enabled: true, phase: "none", cardOnFile: true, offer: { eligible: true, freeOptIn: true } })),
    switchToUsagePricing: vi.fn(async () => ok({ outcome: "switched", switchedEarlyAt: "2026-10-19T12:00:00Z", flatPlanEnded: false })),
    getPersonalUsageSwitch: vi.fn(async () => ok({ enabled: true, phase: "none", cardOnFile: false, offer: { eligible: false, reason: "card-required" } })),
    switchPersonalToUsagePricing: vi.fn(async () => ok({ outcome: "switched" })),
    createBillingPortalSession: vi.fn(async () => ok({ url: "https://billing.stripe.com/p/session/test" })),
    createBillingCheckoutSession: vi.fn(async () => ok({ url: "https://checkout.stripe.com/c/pay/cs_test" })),
    createPersonalBillingCheckoutSession: vi.fn(async () => ok({ url: "https://checkout.stripe.com/c/pay/cs_person" })),
    createPersonalBillingPortalSession: vi.fn(async () => ok({ url: "https://billing.stripe.com/p/session/person" })),
    ...overrides,
  };
}

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    flushSync();
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

async function render(src: ReturnType<typeof source>, extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(UsageSettingsPane, {
    target: host,
    props: { company: src as never, accounts: ACCOUNTS, onopenurl: vi.fn(), onopensync: vi.fn(), ...extra },
  });
  await settle();
}

const q = (id: string, root: ParentNode = host) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const clean = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim();
const header = (key: string) => host.querySelector(`[data-testid="usage-account"][data-key="${key}"]`) as HTMLButtonElement;
const detail = () => q("usage-account-detail");
const lines = () =>
  [...host.querySelectorAll('[data-testid="usage-account"]')].map((el) => [
    clean(el.querySelector('[data-testid="usage-account-name"] .company-label-name') ?? el.querySelector('[data-testid="usage-account-name"]')),
    clean(el.querySelector('[data-testid="usage-account-plan"]')),
    clean(el.querySelector('[data-testid="usage-account-total"]')),
  ]);

async function open(key: string) {
  header(key).click();
  await settle();
}

describe("UsageSettingsPane: one line per account", () => {
  it("lists Personal first, then every company by name, each with its plan and this month's total", async () => {
    const src = source();
    await render(src);
    expect(lines()).toEqual([
      ["Personal", "Starter (free)", "No usage bill"],
      ["Aspen", "", "Owner only"],
      ["Birch", "Trial, 12 days left", "$420.00"],
      ["Cedar", "Legacy plan", "No usage bill"],
      ["Dogwood", "Starter (free)", "No usage bill"],
      ["Elm", "Usage plan", "$1.20"],
      ["Northwind", "Usage plan", "$8.00"],
    ]);
    // Every line starts closed, and the admin company is never read with the owner-gated routes.
    expect(detail()).toBeNull();
    expect([...host.querySelectorAll('[data-testid="usage-account"]')].every((el) => el.getAttribute("aria-expanded") === "false")).toBe(true);
    expect(src.getBillingSummary).not.toHaveBeenCalledWith("cmp_aspen");
    // The spend limit is the line's marker, so usage lines read it with the
    // line; the old plans and the admin company never do. The switch offer
    // waits until a line opens.
    expect((src.getSpendLimit.mock.calls as unknown as string[][]).map((c) => c[0]).sort()).toEqual(["cmp_birch", "cmp_elm", "cmp_northwind"]);
    expect(src.getUsageSwitch).not.toHaveBeenCalled();
  });

  it("opens a usage company to its groups, included usage, spend limit, projected bill and card", async () => {
    const src = source();
    await render(src);
    await open("cmp_northwind");
    expect(header("cmp_northwind").getAttribute("aria-expanded")).toBe("true");
    const panel = detail()!;
    expect(panel.getAttribute("role")).toBe("region");
    expect(panel.getAttribute("aria-labelledby")).toBe(header("cmp_northwind").id);
    const groups = [...panel.querySelectorAll('[data-testid="usage-group"]')].map((el) => [el.getAttribute("data-group"), clean(el)]);
    expect(groups).toEqual([["agents", "$6.00"], ["sync", "$2.00"], ["storage", "$0.00"]]);
    // Meter rates come from the price list, shown on hover.
    expect(panel.querySelector('[data-testid="usage-line"][data-key="agent-run"]')?.getAttribute("title")).toBe("$0.05 per run");
    expect(clean(q("usage-total", panel))).toBe("$8.00");
    expect(clean(q("usage-allowance-left", panel))).toBe("$2.00 of free usage left");
    expect(clean(q("usage-spend-limit", panel))).toBe("$250.00 a month");
    expect(clean(q("usage-projected", panel))).toBe("$6.00");
    expect(clean(q("usage-card", panel))).toBe("Yes");
    expect(clean(q("usage-billing", panel))).toBe("Manage billing");
    expect(q("usage-switch", panel)).toBeNull();
    expect(src.getSpendLimit).toHaveBeenCalledWith("cmp_northwind");
  });

  it("opens one line at a time, and a second click closes it", async () => {
    await render(source());
    await open("cmp_northwind");
    await open("cmp_birch");
    expect(header("cmp_northwind").getAttribute("aria-expanded")).toBe("false");
    expect(header("cmp_birch").getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelectorAll('[data-testid="usage-account-detail"]')).toHaveLength(1);
    // The trial shows trial usage against the cap.
    expect(clean(q("usage-trial-usage", detail()!))).toBe("$420.00 of $500.00");
    expect(clean(q("usage-card", detail()!))).toBe("No");
    await open("cmp_birch");
    expect(detail()).toBeNull();
    expect(header("cmp_birch").getAttribute("aria-expanded")).toBe("false");
  });

  it("arrow keys, Home and End move between lines", async () => {
    await render(source());
    const first = header("personal");
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(header("cmp_aspen"));
    header("cmp_aspen").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(header("cmp_northwind"));
    header("cmp_northwind").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(header("cmp_elm"));
    header("cmp_elm").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(first);
  });

  it("opens on the account the Core menu was showing", async () => {
    setPreferredUsageAccount("cmp_elm");
    await render(source());
    expect(header("cmp_elm").getAttribute("aria-expanded")).toBe("true");
    expect(clean(q("usage-total", detail()!))).toBe("$1.20");
  });

  it("an admin's company says only an owner can see usage", async () => {
    await render(source());
    await open("cmp_aspen");
    expect(clean(q("usage-owner-only", detail()!))).toBe("Only a company owner can see usage. Ask an owner of Aspen.");
  });

  it("a legacy paid plan shows its plan and card, with no switch action", async () => {
    const src = source();
    await render(src);
    await open("cmp_cedar");
    expect(clean(q("usage-old-plan", detail()!))).toBe("Legacy plan");
    expect(q("usage-switch", detail()!)).toBeNull();
    expect(src.getUsageSwitch).not.toHaveBeenCalled();
  });

  it("Turn off sync opens Settings > Sync", async () => {
    const onopensync = vi.fn();
    await render(source(), { onopensync });
    await open("cmp_northwind");
    q("usage-sync-off", detail()!)!.click();
    expect(onopensync).toHaveBeenCalledTimes(1);
  });

  it("a failed line read says unavailable, never $0, and Try again reads it again", async () => {
    let calls = 0;
    const src = source({
      getBillingSummary: vi.fn(async (uid: string) => {
        if (uid === "cmp_elm" && calls++ === 0) return fail("http-500");
        return SUMMARIES[uid] ? ok(SUMMARIES[uid]) : fail("FORBIDDEN");
      }),
    });
    await render(src);
    expect(clean(header("cmp_elm").querySelector('[data-testid="usage-account-total"]'))).toBe("Unavailable");
    await open("cmp_elm");
    q("usage-retry", detail()!)!.click();
    await settle();
    expect(clean(header("cmp_elm").querySelector('[data-testid="usage-account-total"]'))).toBe("$1.20");
  });
});

describe("UsageSettingsPane: Switch to usage pricing (hq-pro #5081)", () => {
  it("a free company with a card on file confirms, switches, and the line moves to the usage plan", async () => {
    const summaries = { ...SUMMARIES };
    const src = source({
      getBillingSummary: vi.fn(async (uid: string) => (summaries[uid] ? ok(summaries[uid]) : fail("FORBIDDEN"))),
      switchToUsagePricing: vi.fn(async (uid: string) => {
        summaries[uid] = { pricingPlan: "usage-only", usageTrial: { status: "none", cardOnFile: true }, defaultPaymentMethod: { present: true } };
        return ok({ outcome: "switched", switchedEarlyAt: "2026-10-19T12:00:00Z", flatPlanEnded: false });
      }),
    });
    await render(src);
    await open("cmp_dogwood");
    expect(src.getUsageSwitch).toHaveBeenCalledWith("cmp_dogwood");
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("offered");
    q("usage-switch-start", detail()!)!.click();
    await settle();
    const confirm = q("usage-switch-confirm", detail()!)!;
    expect(clean(confirm.querySelector("p"))).toBe(
      "Switch Dogwood to usage pricing? $10.00 of usage is included each month, then each meter is billed at its rate. There's no free trial: usage past the included amount is charged to the card on file. You can't switch back here.",
    );
    // Nothing is sent until Switch now.
    expect(src.switchToUsagePricing).not.toHaveBeenCalled();
    q("usage-switch-now", confirm)!.click();
    flushSync();
    // Pressed: pending at once, and a second press does nothing.
    expect(clean(q("usage-switch-now"))).toBe("Switching…");
    expect((q("usage-switch-now") as HTMLButtonElement).disabled).toBe(true);
    await settle();
    expect(src.switchToUsagePricing).toHaveBeenCalledTimes(1);
    expect(src.switchToUsagePricing).toHaveBeenCalledWith("cmp_dogwood");
    expect(clean(q("usage-switch-result", detail()!))).toBe("Switched to usage pricing.");
    expect(clean(header("cmp_dogwood").querySelector('[data-testid="usage-account-plan"]'))).toBe("Usage plan");
  });

  it("Cancel closes the confirm without switching", async () => {
    const src = source();
    await render(src);
    await open("cmp_dogwood");
    q("usage-switch-start", detail()!)!.click();
    await settle();
    q("usage-switch-cancel", detail()!)!.click();
    await settle();
    expect(q("usage-switch-confirm")).toBeNull();
    expect(src.switchToUsagePricing).not.toHaveBeenCalled();
  });

  it("no card: says a card is needed with no trial, offers Add a card, and no switch button", async () => {
    const onopenurl = vi.fn();
    const src = source({
      getUsageSwitch: vi.fn(async () => ok({ enabled: true, cardOnFile: false, offer: { eligible: false, reason: "card-required" } })),
    });
    await render(src, { onopenurl });
    await open("cmp_dogwood");
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("card-required");
    expect(clean(q("usage-switch-note", detail()!))).toBe("A card is needed to switch. There's no free trial when you switch.");
    expect(q("usage-switch-start", detail()!)).toBeNull();
    expect(clean(q("usage-billing", detail()!))).toBe("Manage billing");
  });

  it("the personal account on Starter with no card offers Add a card through personal card capture", async () => {
    const onopenurl = vi.fn();
    const src = source();
    await render(src, { onopenurl });
    await open("personal");
    expect(src.getPersonalUsageSwitch).toHaveBeenCalledTimes(1);
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("card-required");
    const add = q("usage-billing", detail()!) as HTMLButtonElement;
    expect(clean(add)).toBe("Add a card");
    add.click();
    await settle();
    expect(src.createPersonalBillingCheckoutSession).toHaveBeenCalledTimes(1);
    expect(onopenurl).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_person");
  });

  it("the personal account switches through the person route", async () => {
    const src = source({
      getPersonalUsageSwitch: vi.fn(async () => ok({ enabled: true, cardOnFile: true, offer: { eligible: true, freeOptIn: true } })),
    });
    await render(src);
    await open("personal");
    q("usage-switch-start", detail()!)!.click();
    await settle();
    q("usage-switch-now", detail()!)!.click();
    await settle();
    expect(src.switchPersonalToUsagePricing).toHaveBeenCalledTimes(1);
    expect(src.switchToUsagePricing).not.toHaveBeenCalled();
    expect(clean(q("usage-switch-result", detail()!))).toBe("Switched to usage pricing.");
  });

  it("refused by hq-pro: re-reads the offer and says why in plain words", async () => {
    let reads = 0;
    const src = source({
      getUsageSwitch: vi.fn(async () =>
        reads++ === 0
          ? ok({ enabled: true, cardOnFile: true, offer: { eligible: true, freeOptIn: true } })
          : ok({ enabled: true, cardOnFile: true, offer: { eligible: false, reason: "comped" } }),
      ),
      switchToUsagePricing: vi.fn(async () => fail("USAGE_SWITCH_NOT_OFFERED", "This company cannot switch to usage pricing early")),
    });
    await render(src);
    await open("cmp_dogwood");
    q("usage-switch-start", detail()!)!.click();
    await settle();
    q("usage-switch-now", detail()!)!.click();
    await settle();
    expect(clean(q("usage-switch-result", detail()!))).toBe(
      "This account's plan is set by HQ, so it can't switch here. Contact support to change it.",
    );
    expect(q("usage-switch-confirm")).toBeNull();
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("refused");
    expect(clean(header("cmp_dogwood").querySelector('[data-testid="usage-account-plan"]'))).toBe("Starter (free)");
  });

  it("a conflict keeps the confirm open and asks to try again", async () => {
    const src = source({ switchToUsagePricing: vi.fn(async () => fail("USAGE_SWITCH_CONFLICT")) });
    await render(src);
    await open("cmp_dogwood");
    q("usage-switch-start", detail()!)!.click();
    await settle();
    q("usage-switch-now", detail()!)!.click();
    await settle();
    expect(clean(q("usage-switch-result", detail()!))).toBe("Something changed while switching. Try again.");
    expect(q("usage-switch-confirm")).not.toBeNull();
    expect((q("usage-switch-now") as HTMLButtonElement).disabled).toBe(false);
  });

  it("before #5081 is live (a free company refused as not-paying, or no route): the action shows but isn't available", async () => {
    const preLive = source({
      getUsageSwitch: vi.fn(async () => ok({ enabled: true, cardOnFile: null, offer: { eligible: false, reason: "not-paying" } })),
    });
    await render(preLive);
    await open("cmp_dogwood");
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("not-available");
    expect((q("usage-switch-start", detail()!) as HTMLButtonElement).disabled).toBe(true);
    expect(clean(q("usage-switch-note", detail()!))).toBe("Switching to usage pricing isn't available for this account yet.");
    await unmount(component!);
    component = null;
    host.remove();

    const noRoute = source({ getPersonalUsageSwitch: vi.fn(async () => fail("MISSING_COMPANY_UID")) });
    await render(noRoute);
    await open("personal");
    expect(q("usage-switch", detail()!)?.dataset.state).toBe("not-available");
  });
});

describe("UsageSettingsPane: stacked bars", () => {
  const bar = (key: string) => header(key).querySelector('[data-testid="usage-account-bar"]') as HTMLElement | null;
  const parts = (el: Element | null) => [...(el?.querySelectorAll<HTMLElement>("[data-segment]") ?? [])].map((p) => [p.dataset.segment, p.style.width]);

  it("a usage line draws its groups against the $10 included; a limit far past the scale is not drawn on the line", async () => {
    await render(source());
    const b = bar("cmp_northwind")!;
    expect(b.dataset.tone).toBe("ok");
    expect(parts(b)).toEqual([["agents", "60%"], ["sync", "20%"]]);
    expect(b.querySelector('[data-testid="usage-bar-marker"]')).toBeNull();
    expect(b.querySelector('[data-testid="usage-bar-marker-label"]')).toBeNull();
    expect(clean(header("cmp_northwind").querySelector(".helper"))).toBe("of $10.00 included");
    // The old plans and admin lines have no bar.
    expect(bar("cmp_cedar")).toBeNull();
    expect(bar("cmp_aspen")).toBeNull();
    expect(bar("personal")).toBeNull();
  });

  it("a trial line is trial usage against the cap, amber from 80%", async () => {
    await render(source());
    const b = bar("cmp_birch")!;
    expect(parts(b)).toEqual([["trial", "84%"]]);
    expect(b.dataset.tone).toBe("near");
    expect(header("cmp_birch").dataset.tone).toBe("near");
    // The cap is the bar's end, named by the helper; no floating label.
    expect(b.querySelector('[data-testid="usage-bar-marker-label"]')).toBeNull();
    expect(clean(header("cmp_birch").querySelector(".helper"))).toBe("of $500.00 trial cap");
    // Opened, the trial shows one trial bar and one sentence, not $0.00 groups.
    await open("cmp_birch");
    expect(detail()!.querySelectorAll(".group")).toHaveLength(0);
    expect(clean(q("usage-trial-usage", detail()!))).toBe("$420.00 of $500.00");
    expect(clean(q("usage-trial-note", detail()!))).toBe("Trial days are free. Costs by group start when the trial ends.");
    expect(clean(q("usage-trial-days", detail()!))).toBe("12 days left");
  });

  it("parts keep their group colours at every tone; the limit state is the outline and the total's colour", async () => {
    const summaries = { ...SUMMARIES, cmp_elm: { pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: false } } };
    await render(
      source({
        getBillingSummary: vi.fn(async (uid: string) => (summaries[uid as keyof typeof summaries] ? ok(summaries[uid as keyof typeof summaries]) : fail("FORBIDDEN"))),
        getUsageStatement: vi.fn(async (uid: string) => ok(statement(uid === "cmp_elm" ? 880 : USAGE[uid] ?? 0))),
      }),
    );
    const near = bar("cmp_elm")!;
    const calm = bar("cmp_northwind")!;
    expect(near.dataset.tone).toBe("near");
    const colour = (el: Element, id: string) => (el.querySelector(`[data-segment="${id}"]`) as HTMLElement).style.getPropertyValue("--seg");
    expect(colour(near, "agents")).toBe(colour(calm, "agents"));
    expect(colour(near, "sync")).toBe(colour(calm, "sync"));
  });

  it("a limit that falls on the scale is drawn as a tick and labelled at it", async () => {
    const summaries = { ...SUMMARIES, cmp_northwind: { pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true } } };
    await render(
      source({
        getBillingSummary: vi.fn(async (uid: string) => (summaries[uid as keyof typeof summaries] ? ok(summaries[uid as keyof typeof summaries]) : fail("FORBIDDEN"))),
        getUsageStatement: vi.fn(async (uid: string) => ok(statement(uid === "cmp_northwind" ? 1500 : USAGE[uid] ?? 0))),
        getSpendLimit: vi.fn(async () => ok({ limitCents: 1200, custom: true, paused: false })),
      }),
    );
    const b = bar("cmp_northwind")!;
    expect((b.querySelector('[data-testid="usage-bar-marker"]') as HTMLElement).style.left).toBe("80%");
    expect(clean(b.querySelector('[data-testid="usage-bar-marker-label"]'))).toBe("Limit $12.00");
    expect(b.dataset.tone).toBe("at");
  });

  it("with no card the included usage is the limit: amber near it, red and marked when sync is paused", async () => {
    const summaries = {
      ...SUMMARIES,
      cmp_elm: { pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: false } },
      cmp_northwind: { pricingPlan: "usage-only", usageTrial: { status: "ended", syncPaused: true, pauseReason: "usage_card_required", allowanceCents: 1000, cardOnFile: false } },
    };
    const usage: Record<string, number> = { ...USAGE, cmp_elm: 880, cmp_northwind: 1040 };
    await render(
      source({
        getBillingSummary: vi.fn(async (uid: string) => (summaries[uid as keyof typeof summaries] ? ok(summaries[uid as keyof typeof summaries]) : fail("FORBIDDEN"))),
        getUsageStatement: vi.fn(async (uid: string) => ok(statement(usage[uid] ?? 0))),
      }),
    );
    expect(bar("cmp_elm")?.dataset.tone).toBe("near");
    expect(bar("cmp_northwind")?.dataset.tone).toBe("at");
    expect(clean(q("usage-account-paused", header("cmp_northwind")))).toBe("Sync paused");
    expect(q("usage-account-paused", header("cmp_elm"))).toBeNull();
    // Past the included usage the scale grows and an "included" tick marks $10.
    expect(bar("cmp_northwind")?.querySelector(".tick.included")).not.toBeNull();
  });

  it("opening a line grows one labelled bar per group and says the projected bill is after the included usage", async () => {
    await render(source());
    await open("cmp_northwind");
    const groups = [...detail()!.querySelectorAll(".group")];
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual([
      "Agents and AI $6.00",
      "Sync $2.00",
      "Storage and vaults $0.00",
    ]);
    expect(groups[0]!.getAttribute("title")).toContain("Agent run: $4.00 ($0.05 per run)");
    expect(clean(q("usage-projected-note", detail()!))).toBe("At this pace, after the $10.00 included");
  });

  it("the switch confirm keeps its two buttons on one row, with the other actions hidden", async () => {
    await render(source());
    await open("cmp_dogwood");
    expect(q("usage-billing", detail()!)).not.toBeNull();
    q("usage-switch-start", detail()!)!.click();
    await settle();
    const rows = [...detail()!.querySelectorAll(".actions")];
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.querySelectorAll("button")].map((b) => b.dataset.testid)).toEqual(["usage-switch-now", "usage-switch-cancel"]);
    expect(q("usage-billing", detail()!)).toBeNull();
  });
});

describe("UsageSettingsPane: review follow-ups", () => {
  it("a group's meters open from the keyboard with a button, not only on hover", async () => {
    await render(source());
    await open("cmp_northwind");
    const toggle = detail()!.querySelector('[data-testid="usage-group-toggle"]') as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    flushSync();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.closest(".group")?.classList.contains("show")).toBe(true);
  });

  it("a local-only company (no cloud uid) is not listed", async () => {
    await render(source(), { accounts: [...ACCOUNTS, { kind: "company", uid: null, name: "Local Co", role: "owner" }] });
    expect(lines().map((l) => l[0])).not.toContain("Local Co");
  });

  it("a closed line points at no panel; an open one does", async () => {
    await render(source());
    expect(header("cmp_northwind").hasAttribute("aria-controls")).toBe(false);
    await open("cmp_northwind");
    expect(header("cmp_northwind").getAttribute("aria-controls")).toBe(detail()!.id);
  });
});

describe("UsageSettingsPane: re-reads only when the account set changes", () => {
  it("a new array with the same accounts reads nothing again; one more account reads only that one", async () => {
    const src = source();
    host = document.createElement("div");
    document.body.append(host);
    component = mount(UsageSettingsPaneAccountsProbe, {
      target: host,
      props: { source: src as never, accounts: ACCOUNTS, extra: { kind: "company", uid: "cmp_oak", name: "Oak", role: "owner" } },
    });
    await settle();
    const summaries = () => src.getBillingSummary.mock.calls.length;
    const before = summaries();
    expect(before).toBeGreaterThan(0);
    (host.querySelector('[data-testid="probe-same"]') as HTMLElement).click();
    await settle();
    expect(summaries()).toBe(before);
    (host.querySelector('[data-testid="probe-add"]') as HTMLElement).click();
    await settle();
    expect(src.getBillingSummary).toHaveBeenCalledWith("cmp_oak");
  });
});
