// @vitest-environment happy-dom
//
// Settings > Usage (usage-only-pricing US-018): per-meter costs, allowance,
// trial, spend limit, projected bill, and the plain fallback.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import UsageSettingsPane from "./UsageSettingsPane.svelte";

const ok = (value: unknown) => ({ ok: true as const, value });
const fail = (code: string, message = code) => ({ ok: false as const, reason: "error" as const, code, message });

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

const STATEMENT = {
  periodStart: "2026-10-01",
  periodEnd: "2026-10-31",
  asOf: "2026-10-17",
  complete: true,
  allowanceCents: 1000,
  usageCents: 640,
  allowanceLeftCents: 360,
  billCents: 0,
  projectedBillCents: 220,
  lines: [
    { key: "member-sync", displayName: "Sync", unit: "sync", unitCents: 10, status: "measured", billed: true, units: 40, costCents: 400 },
    { key: "agent-run", displayName: "Agent run", unit: "run", unitCents: 5, status: "measured", billed: true, units: 48, costCents: 240 },
  ],
  free: [],
};

const PRICING = {
  usage: {
    includedUsd: 10,
    trial: { days: 30, capUsd: 500 },
    meters: [
      { id: "member-sync", label: "Sync", unit: "sync", unitUsd: 0.1 },
      { id: "agent-run", label: "Agent run", unit: "run", unitUsd: 0.05 },
    ],
    boxes: [{ size: "small", instanceType: "t3.small", monthlyUsd: 100 }],
  },
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    getBillingSummary: vi.fn(async () => ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", cardOnFile: true } })),
    getUsageStatement: vi.fn(async () => ok(STATEMENT)),
    getPricing: vi.fn(async () => ok(PRICING)),
    getSpendLimit: vi.fn(async () => ok({ limitCents: 10000, custom: false, paused: false })),
    ...overrides,
  };
}

const COMPANIES = [{ uid: "cmp_northwind", label: "Northwind", role: "owner" }];

async function settle() {
  flushSync();
  for (let i = 0; i < 5; i += 1) await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

async function render(src: ReturnType<typeof source>, companies: unknown[] = COMPANIES) {
  host = document.createElement("div");
  document.body.append(host);
  component = mount(UsageSettingsPane, {
    target: host,
    props: { company: src as never, companies: companies as never, selectedCompanyUid: "cmp_northwind" },
  });
  await settle();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const text = (id: string) => q(id)?.textContent?.replace(/\s+/g, " ").trim();

describe("UsageSettingsPane", () => {
  it("shows each meter's cost with its rate, the allowance left, projected bill and spend limit", async () => {
    await render(source());
    expect(q("settings-usage-pane")?.dataset.state).toBe("ready");
    expect(text("usage-plan")).toBe("Usage plan");
    const rows = [...host.querySelectorAll('[data-testid="usage-line"]')].map((r) =>
      [...r.querySelectorAll("td")].map((td) => td.textContent?.trim()),
    );
    expect(rows).toEqual([
      ["Sync", "$0.10 per sync", "40 syncs", "$4.00"],
      ["Agent run", "$0.05 per run", "48 runs", "$2.40"],
    ]);
    expect(text("usage-total")).toBe("$6.40");
    expect(text("usage-allowance-left")).toBe("$3.60 of free usage left");
    expect(text("usage-projected")).toBe("$2.20");
    expect(text("usage-spend-limit")).toBe("$100.00 a month (default)");
    expect(q("usage-trial")).toBeNull();
  });

  it("shows trial days left and trial usage against the cap during the trial", async () => {
    const endsAt = new Date(Date.now() + 4.5 * 86_400_000).toISOString();
    await render(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "active", endsAt, capCents: 50000, usedCents: 9900 } }),
        ),
      }),
    );
    expect(text("usage-plan")).toBe("Trial, 5 days left");
    expect(text("usage-trial-days")).toMatch(/^5 days left\. Ends /);
    expect(text("usage-trial-usage")).toBe("$99.00 of $500.00");
  });

  it("a non-owner gets a plain note and no read", async () => {
    const src = source();
    await render(src, [{ uid: "cmp_northwind", label: "Northwind", role: "member" }]);
    expect(q("settings-usage-pane")?.dataset.state).toBe("owner-only");
    expect(text("usage-owner-only")).toContain("Only a company owner can see usage");
    expect(src.getBillingSummary).not.toHaveBeenCalled();
  });

  it("a failed read shows a plain fallback, never server text, and Try again re-reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const src = source({
      getUsageStatement: vi.fn(async () => fail("http-500", '{"message":"Internal Server Error"}')),
    });
    await render(src);
    expect(q("settings-usage-pane")?.dataset.state).toBe("unavailable");
    expect(text("usage-unavailable")).toBe("Usage isn't available right now.");
    expect(host.textContent).not.toContain("Internal Server Error");
    expect(host.textContent).not.toContain("$0.00");
    src.getUsageStatement.mockResolvedValueOnce(ok(STATEMENT) as never);
    q("usage-retry")!.click();
    await settle();
    expect(src.getUsageStatement).toHaveBeenCalledTimes(2);
    expect(q("settings-usage-pane")?.dataset.state).toBe("ready");
  });

  it("switches company from the picker", async () => {
    const src = source();
    await render(src, [...COMPANIES, { uid: "cmp_acme", label: "Acme", role: "owner" }]);
    const chips = host.querySelectorAll('[data-testid="usage-company"]');
    expect(chips).toHaveLength(2);
    (chips[1] as HTMLElement).click();
    await settle();
    expect(src.getUsageStatement).toHaveBeenLastCalledWith("cmp_acme");
  });

  it("with no company says usage is per company", async () => {
    await render(source(), []);
    expect(q("usage-none")).not.toBeNull();
  });

  it("shows the pause reason on the Usage screen too", async () => {
    await render(
      source({
        getBillingSummary: vi.fn(async () =>
          ok({ pricingPlan: "usage-only", usageTrial: { status: "ended", allowanceCents: 1000, cardRequired: true, pauseReason: "usage_card_required", syncPaused: true } }),
        ),
      }),
    );
    expect(q("usage-notice")?.dataset.kind).toBe("paused-card-required");
    expect(text("usage-notice")).toContain("Add a card to resume");
  });
});
