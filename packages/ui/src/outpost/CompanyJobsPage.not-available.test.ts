// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyJobsPage from "./CompanyJobsPage.svelte";
import { createCompanyJobStore, type CompanyJobStore } from "./company-jobs-stub.js";
import type { CompanyBoxOption, CompanyJobRole } from "./company-jobs-model.js";

const NOW = Date.parse("2026-10-18T15:00:00.000Z");
const CRON = "cron(0 9 ? * MON-FRI *)";
const BOXES: CompanyBoxOption[] = [
  { id: "opc_1", name: "main" },
  { id: "opc_2", name: "other" },
];
// Owner, 2026-10-19: no billing, price, payer or charge wording anywhere on this screen.
const BILLING_WORDS = /bill|payment|\bpay\b|payer|\bpaid\b|charge|price|pricing|cost|invoice|subscription|\$|usd|per month|a month/i;

function definition(name: string): Record<string, unknown> {
  return {
    prompt: `Run ${name}.`,
    context: { name },
    schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" },
  };
}

type Fixture = {
  name: string;
  boxes?: CompanyBoxOption[];
  outpostId?: string | null;
  seed?: (store: CompanyJobStore) => Promise<void>;
  open?: "add" | "watchdog" | "log" | "invalid";
};

async function seedRows(store: CompanyJobStore): Promise<void> {
  const admin = store.client({ uid: "prs_seed", role: "admin" });
  const health = ["ok", "missed", "blocked", "stale", "unknown"] as const;
  for (const value of health) {
    const created = await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition(`${value} job`) });
    if (!created.ok || !created.job) throw new Error("seed failed");
    store.setHealth(created.job.jobId, {
      health: value,
      lastRunAt: value === "unknown" ? null : "2026-10-18T14:00:00.000Z",
      nextRunAt: "2026-10-18T16:00:00.000Z",
      message: value === "ok" ? "" : "The last run needs a look.",
    });
  }
}

const FIXTURES: Fixture[] = [
  { name: "list", seed: seedRows },
  { name: "empty" },
  { name: "add", open: "add" },
  { name: "watchdog", open: "watchdog" },
  { name: "invalid", open: "invalid" },
  { name: "log", seed: seedRows, open: "log" },
  {
    name: "paused",
    seed: async (store) => {
      const admin = store.client({ uid: "prs_seed", role: "admin" });
      const created = await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
      if (!created.ok || !created.job) throw new Error("seed failed");
      await admin.submit({ companyUid: "cmp_1", action: "disable", jobId: created.job.jobId, revision: created.job.revision });
    },
  },
  {
    name: "load-error",
    seed: async (store) => {
      store.failList = true;
      store.failStatus = true;
    },
  },
  { name: "blocked", boxes: [{ id: "opc_1", name: "main", blocked: true }], outpostId: "opc_1" },
  { name: "stopped", boxes: [{ id: "opc_1", name: "main", stopped: true }], outpostId: "opc_1" },
  { name: "not-available-box", boxes: [{ id: "opc_1", name: "main", blocked: true, unavailable: true }] },
  {
    name: "not-available-code",
    seed: async (store) => {
      store.failCode = "billing_required";
    },
  },
  {
    name: "payment-not-set-up",
    seed: async (store) => {
      store.failCode = "payment_not_set_up";
    },
  },
];

describe("company jobs screen shows no billing wording", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    delete document.documentElement.dataset.forceTheme;
  });

  async function render(props: Record<string, unknown>): Promise<HTMLElement> {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyJobsPage, { target, props: { now: NOW, companyUid: "cmp_1", boxes: BOXES, ...props } });
    flushSync();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-page']")?.getAttribute("data-ready")).toBe("true");
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    return target;
  }

  function visibleText(target: HTMLElement): string {
    const attrs = [...target.querySelectorAll("[aria-label],[title],[placeholder]")].flatMap((el) => [
      el.getAttribute("aria-label") ?? "",
      el.getAttribute("title") ?? "",
      el.getAttribute("placeholder") ?? "",
    ]);
    const values = [...target.querySelectorAll("input,textarea")].map((el) => (el as HTMLInputElement).value);
    return [target.textContent ?? "", ...attrs, ...values].join("\n");
  }

  for (const theme of ["light", "dark"] as const) {
    for (const role of ["admin", "member"] as CompanyJobRole[]) {
      for (const fixture of FIXTURES) {
        if (role === "member" && (fixture.open === "add" || fixture.open === "watchdog" || fixture.open === "invalid")) continue;
        it(`${fixture.name}, ${role}, ${theme}`, async () => {
          document.documentElement.dataset.forceTheme = theme;
          const store = createCompanyJobStore();
          await fixture.seed?.(store);
          const client = role === "member"
            ? store.client({ uid: "prs_m", role: "member" }, { writesAllowed: false, memberRead: true })
            : store.client({ uid: "prs_a", role: "admin" });
          const target = await render({
            role,
            client,
            ...(fixture.boxes ? { boxes: fixture.boxes } : {}),
            ...(fixture.outpostId ? { outpostId: fixture.outpostId } : {}),
          });
          if (fixture.open === "add" || fixture.open === "invalid") {
            (target.querySelector("[data-testid='company-jobs-add']") as HTMLButtonElement).click();
            flushSync();
          }
          if (fixture.open === "watchdog") {
            (target.querySelector("[data-testid='company-jobs-watchdog']") as HTMLButtonElement).click();
            flushSync();
          }
          if (fixture.open === "invalid") {
            (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
            flushSync();
          }
          if (fixture.open === "log") {
            (target.querySelector("[data-testid='company-jobs-log']") as HTMLButtonElement).click();
            flushSync();
          }
          const text = visibleText(target);
          expect(text.trim().length).toBeGreaterThan(0);
          expect(text).not.toMatch(BILLING_WORDS);
        });
      }
    }
  }
});

describe("company jobs not available yet state", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  async function render(props: Record<string, unknown>): Promise<HTMLElement> {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyJobsPage, { target, props: { now: NOW, companyUid: "cmp_1", boxes: BOXES, ...props } });
    flushSync();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-page']")?.getAttribute("data-ready")).toBe("true");
    });
    return target;
  }

  for (const code of ["billing_required", "payment_not_set_up"]) {
    for (const role of ["admin", "member"] as CompanyJobRole[]) {
      it(`shows one plain line and Contact us when the read returns ${code} (${role})`, async () => {
        const store = createCompanyJobStore();
        store.failCode = code;
        const contact = vi.fn(async () => ({ ok: true as const, value: null }));
        const client = role === "member"
          ? store.client({ uid: "prs_m", role: "member" }, { writesAllowed: false, memberRead: true })
          : store.client({ uid: "prs_a", role: "admin" });
        const target = await render({ role, client, contact });
        await vi.waitFor(() => {
          expect(target.querySelector("[data-testid='company-jobs-not-available']")).not.toBeNull();
        });
        const block = target.querySelector("[data-testid='company-jobs-not-available']") as HTMLElement;
        expect(block.querySelector("[data-testid='company-jobs-not-available-copy']")?.textContent).toBe(
          "Outposts are not available for this company yet.",
        );
        const actions = block.querySelectorAll("button");
        expect(actions).toHaveLength(1);
        expect(actions[0].textContent?.trim()).toBe("Contact us");
        expect(target.querySelector("[data-testid='company-jobs-load-error']")).toBeNull();
        expect(target.querySelector("[data-testid='company-jobs-read-denied']")).toBeNull();
        expect(target.querySelector("[data-testid='company-jobs-blocked-note']")).toBeNull();
        expect(target.querySelector("[data-testid='company-jobs-add']")).toBeNull();
        expect(target.querySelector("[data-testid='company-jobs-watchdog']")).toBeNull();

        actions[0].click();
        flushSync();
        await vi.waitFor(() => {
          expect(target.querySelector("[data-testid='company-jobs-contact-sent']")?.textContent).toBe(
            "HQ has been notified and will follow up by email.",
          );
        });
        expect(contact).toHaveBeenCalledWith("cmp_1");
        expect(target.querySelector("[data-testid='company-jobs-contact-us']")).toBeNull();
      });
    }
  }

  it("shows the state for a box the list reports as unavailable, and keeps other boxes working", async () => {
    const store = createCompanyJobStore();
    const target = await render({
      role: "admin",
      client: store.client({ uid: "prs_a", role: "admin" }),
      boxes: [
        { id: "opc_1", name: "main", blocked: true, unavailable: true },
        { id: "opc_2", name: "other" },
      ],
      outpostId: "opc_1",
      contact: async () => ({ ok: true as const, value: null }),
    });
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-not-available-copy']")?.textContent).toBe(
        "Outposts are not available for this company yet.",
      );
    });
    expect(target.querySelector("[data-testid='company-jobs-blocked-note']")).toBeNull();

    (target.querySelector("[data-testid='company-jobs-box-filter']") as HTMLButtonElement).click();
    flushSync();
    const other = [...target.querySelectorAll("[data-testid='company-jobs-box-filter-menu'] [data-value]")].find(
      (el) => el.getAttribute("data-value") === "opc_2",
    ) as HTMLElement;
    other.click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-not-available']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-add']")).not.toBeNull();
  });

  it("switches to the state when a save returns billing_required", async () => {
    const store = createCompanyJobStore();
    const target = await render({ role: "admin", client: store.client({ uid: "prs_a", role: "admin" }) });
    (target.querySelector("[data-testid='company-jobs-add']") as HTMLButtonElement).click();
    flushSync();
    const name = target.querySelector("[data-testid='company-jobs-name']") as HTMLInputElement;
    name.value = "Weekday note";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    const prompt = target.querySelector("[data-testid='company-jobs-run']") as HTMLTextAreaElement;
    prompt.value = "Write the weekday note.";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    (target.querySelector("[data-testid='company-jobs-box']") as HTMLButtonElement).click();
    flushSync();
    (target.querySelector("[data-testid='company-jobs-box-menu'] [data-value='opc_1']") as HTMLElement).click();
    flushSync();
    store.failCode = "billing_required";
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-not-available']")).not.toBeNull();
    });
    expect(target.querySelector("[data-testid='company-jobs-form']")).toBeNull();
    expect(target.textContent).not.toMatch(BILLING_WORDS);
  });

  it("keeps the state after a refused write when a later read succeeds", async () => {
    const store = createCompanyJobStore();
    await seedRows(store);
    const base = store.client({ uid: "prs_a", role: "admin" });
    let reads = 0;
    const client = {
      list: (companyUid: string, outpostId?: string | null) => {
        reads += 1;
        return base.list(companyUid, outpostId);
      },
      status: (companyUid: string, outpostId?: string | null) => base.status(companyUid, outpostId),
      submit: async () => ({ ok: false as const, reason: "error" as const, code: "billing_required" }),
    };
    const target = await render({ role: "admin", client });
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-pause']")).not.toBeNull();
    });
    (target.querySelector("[data-testid='company-jobs-pause']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-not-available']")).not.toBeNull();
    });

    const before = reads;
    (target.querySelector("[data-testid='company-jobs-box-filter']") as HTMLButtonElement).click();
    flushSync();
    (target.querySelector("[data-testid='company-jobs-box-filter-menu'] [data-value='opc_1']") as HTMLElement).click();
    flushSync();
    await vi.waitFor(() => {
      expect(reads).toBeGreaterThan(before);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-not-available']")).not.toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-add']")).toBeNull();
  });

  it("shows a retry line when the contact request fails", async () => {
    const store = createCompanyJobStore();
    store.failCode = "billing_required";
    const target = await render({
      role: "admin",
      client: store.client({ uid: "prs_a", role: "admin" }),
      contact: async () => ({ ok: false as const, reason: "error" as const, code: "http-500" }),
    });
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-contact-us']")).not.toBeNull();
    });
    (target.querySelector("[data-testid='company-jobs-contact-us']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-contact-error']")?.textContent).toBe("Something went wrong. Try again.");
    });
    expect(target.querySelector("[data-testid='company-jobs-contact-us']")).not.toBeNull();
  });
});
