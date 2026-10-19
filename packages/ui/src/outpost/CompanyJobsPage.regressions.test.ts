// @vitest-environment happy-dom
// Regression coverage for the five critical findings in the 67abc737 re-review.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyJobsPage from "./CompanyJobsPage.svelte";
import CompanyJobsSwitchHarness from "./CompanyJobsSwitchHarness.test-support.svelte";
import { companyJobsHttpClient, type JobsWriteResult, type CompanyJobsClient } from "./company-jobs-client.js";
import { createCompanyJobStore } from "./company-jobs-stub.js";
import type { CompanyBoxOption } from "./company-jobs-model.js";

const NOW = Date.parse("2026-10-18T15:00:00.000Z");
const CRON = "cron(0 9 ? * MON-FRI *)";
const BOXES: CompanyBoxOption[] = [
  { id: "opc_1", name: "main" },
  { id: "opc_2", name: "other" },
];
const ADMIN = { uid: "prs_a", role: "admin" as const };

function definition(name: string, prompt = "Write the weekday note."): Record<string, unknown> {
  return {
    prompt,
    context: { name },
    schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" },
  };
}

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

function mountPage(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(CompanyJobsPage, { target, props: { now: NOW, boxes: BOXES, ...props } });
  flushSync();
  return target;
}

async function ready(target: HTMLElement): Promise<void> {
  await vi.waitFor(() => {
    expect(target.querySelector("[data-testid='company-jobs-page']")?.getAttribute("data-ready")).toBe("true");
  });
}

function click(target: HTMLElement, testid: string): void {
  const button = target.querySelector(`[data-testid='${testid}']`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${testid}`);
  button.click();
  flushSync();
}

function rowNames(target: HTMLElement): string[] {
  return [...target.querySelectorAll("[data-testid='company-jobs-row'] .name")].map((el) => el.textContent ?? "");
}

describe("critical 1: edit round-trips the job definition", () => {
  it("keeps the script and every context key when only the name changes", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: { ...definition("Scripted"), context: { name: "Scripted", owner: "ops", tags: ["a"] }, script: "echo hi" },
    });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-edit']")).toBeTruthy());
    click(target, "company-jobs-edit");
    const name = target.querySelector("[data-testid='company-jobs-name']") as HTMLInputElement;
    name.value = "Scripted renamed";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    click(target, "company-jobs-submit");
    await vi.waitFor(() => expect(rowNames(target)).toEqual(["Scripted renamed"]));
    const update = store.requests.find((req) => req.body?.action === "update");
    expect(update?.body?.definition).toEqual({
      prompt: "Write the weekday note.",
      context: { name: "Scripted renamed", owner: "ops", tags: ["a"] },
      script: "echo hi",
      schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" },
    });
    const listed = await admin.list("cmp_1", "opc_1");
    expect(listed.ok && listed.jobs[0]).toMatchObject({ script: "echo hi", context: { name: "Scripted renamed", owner: "ops", tags: ["a"] } });
  });

  it("offers no Edit for a one-time job, so its schedule is never rewritten as recurring", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: { prompt: "Once", context: { name: "One time" }, schedule: { kind: "once", at: "2026-11-01T09:00:00.000Z", timezone: "UTC" } },
    });
    expect(created.ok).toBe(true);
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    await vi.waitFor(() => expect(rowNames(target)).toEqual(["One time"]));
    expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeTruthy();
    expect(target.querySelector("[data-testid='company-jobs-edit']")).toBeNull();
  });
});

describe("critical 2: row actions wait for the server", () => {
  it("sends one run-now when Run now is clicked twice, and shows it is working", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
    let release: () => void = () => {};
    const client: CompanyJobsClient = {
      list: (company, box) => admin.list(company, box),
      status: (company, box) => admin.status(company, box),
      submit: (input) =>
        new Promise<JobsWriteResult>((resolve) => {
          release = () => resolve(admin.submit(input) as unknown as JobsWriteResult);
        }),
    };
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-run-now']")).toBeTruthy());
    const run = target.querySelector("[data-testid='company-jobs-run-now']") as HTMLButtonElement;
    run.click();
    run.click();
    flushSync();
    expect(run.disabled).toBe(true);
    expect(run.getAttribute("aria-busy")).toBe("true");
    expect(run.textContent).toBe("Starting…");
    for (const id of ["company-jobs-pause", "company-jobs-edit", "company-jobs-remove"]) {
      expect((target.querySelector(`[data-testid='${id}']`) as HTMLButtonElement).disabled, id).toBe(true);
    }
    release();
    await vi.waitFor(() => expect(store.runs).toHaveLength(1));
    await vi.waitFor(() => expect((target.querySelector("[data-testid='company-jobs-run-now']") as HTMLButtonElement).disabled).toBe(false));
    expect(store.requests.filter((req) => req.body?.action === "run-now")).toHaveLength(1);
  });

  it("shows a pending label on Pause and Remove job while they are in flight", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
    const held: Array<() => void> = [];
    const client: CompanyJobsClient = {
      list: (company, box) => admin.list(company, box),
      status: (company, box) => admin.status(company, box),
      submit: (input) =>
        new Promise<JobsWriteResult>((resolve) => {
          held.push(() => resolve(admin.submit(input) as unknown as JobsWriteResult));
        }),
    };
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeTruthy());
    click(target, "company-jobs-pause");
    click(target, "company-jobs-pause");
    expect(target.querySelector("[data-testid='company-jobs-pause']")?.textContent).toBe("Pausing…");
    expect(held).toHaveLength(1);
    held.shift()?.();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-resume']")).toBeTruthy());
    click(target, "company-jobs-resume");
    expect(target.querySelector("[data-testid='company-jobs-resume']")?.textContent).toBe("Resuming…");
    held.shift()?.();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeTruthy());
    click(target, "company-jobs-remove");
    click(target, "company-jobs-remove-confirm");
    click(target, "company-jobs-remove-confirm");
    expect(target.querySelector("[data-testid='company-jobs-remove-confirm']")?.textContent).toBe("Removing…");
    expect(held).toHaveLength(1);
    held.shift()?.();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-row']")).toBeNull());
  });
});

describe("critical 3: All boxes reads every company Outpost", () => {
  it("lists jobs from each box, because the server reads only the legacy Outpost without an outpostId", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("On main") });
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_2", definition: definition("On other") });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    await vi.waitFor(() => expect(rowNames(target).sort()).toEqual(["On main", "On other"]));
    const reads = store.requests.filter((req) => req.body?.action === "list" || req.method === "GET");
    expect(reads.every((req) => (req.body?.outpostId ?? new URL(req.path, "https://x").searchParams.get("outpostId")) !== null)).toBe(true);
  });

  it("waits for the box list before reading All boxes", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_7", definition: definition("Named box job") });
    const api = {
      listCompanyOutposts: async () => ({ ok: true as const, value: { outposts: [{ outpostId: "opc_7", name: "seven", lifecycle: "ready" }] } }),
    };
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin, api, boxes: undefined });
    await ready(target);
    await vi.waitFor(() => expect(rowNames(target)).toEqual(["Named box job"]));
    expect(store.requests.some((req) => req.body?.action === "list" && !req.body?.outpostId)).toBe(false);
  });
});

describe("critical 4: a never-run job waits for its first run against the real server shape", () => {
  it("shows Waiting for first run and Never when the server ignores include=pending", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Fresh job") });
    const legacyServer = companyJobsHttpClient(
      { request: (method, path, body) => Promise.resolve(store.request(ADMIN, method, path.replace("&include=pending", ""), body)) },
      { writesAllowed: true },
    );
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: legacyServer });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-row']")).toBeTruthy());
    const row = target.querySelector("[data-testid='company-jobs-row']");
    expect(row?.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Waiting for first run");
    expect(row?.querySelector("[data-testid='company-jobs-last']")?.textContent).toBe("Never");
  });

  it("shows Waiting for first run for a fresh job read through the client", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Fresh job") });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Waiting for first run"));
    expect(store.requests.filter((req) => req.method === "GET").every((req) => req.path.includes("include=pending"))).toBe(true);
  });
});

describe("critical 5: switching company clears the last company's state", () => {
  it("drops not-available and the contact note when the next company can run Outposts", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_2", action: "create", outpostId: "opc_3", definition: definition("Second company job") });
    const api = {
      listCompanyOutposts: async (companyUid: string) => ({
        ok: true as const,
        value: {
          outposts: companyUid === "cmp_1"
            ? [{ outpostId: "opc_1", name: "main", lifecycle: "blocked", blockedReason: "billing_required" }]
            : [{ outpostId: "opc_3", name: "third", lifecycle: "ready" }],
        },
      }),
    };
    const contacted: string[] = [];
    const contact = async (companyUid: string) => {
      contacted.push(companyUid);
      return { ok: true as const, value: null };
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyJobsSwitchHarness, {
      target,
      props: { companies: ["cmp_1", "cmp_2"], role: "admin", client: admin, api, contact, now: NOW },
    });
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-not-available']")).toBeTruthy());
    click(target, "company-jobs-contact-us");
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-contact-sent']")).toBeTruthy());
    expect(contacted).toEqual(["cmp_1"]);

    click(target, "harness-next-company");
    await vi.waitFor(() => expect(rowNames(target)).toEqual(["Second company job"]));
    expect(target.querySelector("[data-testid='company-jobs-not-available']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-contact-sent']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-add']")).toBeTruthy();
    expect(target.querySelector("[data-testid='company-jobs-watchdog']")).toBeTruthy();

    click(target, "harness-next-company");
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-contact-us']")).toBeTruthy());
    expect(target.querySelector("[data-testid='company-jobs-contact-sent']")).toBeNull();
  });

  it("drops a refused write from the last company", async () => {
    const store = createCompanyJobStore();
    const admin = store.client(ADMIN);
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("First job") });
    await admin.submit({ companyUid: "cmp_2", action: "create", outpostId: "opc_1", definition: definition("Second job") });
    const client: CompanyJobsClient = {
      list: (company, box) => admin.list(company, box),
      status: (company, box) => admin.status(company, box),
      submit: async (input) => (input.companyUid === "cmp_1" ? { ok: false, code: "billing_required" } : admin.submit(input)),
    };
    const api = {
      listCompanyOutposts: async () => ({ ok: true as const, value: { outposts: [{ outpostId: "opc_1", name: "main", lifecycle: "ready" }] } }),
    };
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyJobsSwitchHarness, {
      target,
      props: { companies: ["cmp_1", "cmp_2"], role: "admin", client, api, now: NOW },
    });
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeTruthy());
    click(target, "company-jobs-pause");
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-not-available']")).toBeTruthy());
    click(target, "harness-next-company");
    await vi.waitFor(() => expect(rowNames(target)).toEqual(["Second job"]));
    expect(target.querySelector("[data-testid='company-jobs-not-available']")).toBeNull();
  });
});
