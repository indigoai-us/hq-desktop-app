// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CompanyJobsPage from "./CompanyJobsPage.svelte";
import type { CompanyJobsClient, JobsListResult } from "./company-jobs-client.js";
import { createCompanyJobStore } from "./company-jobs-stub.js";
import type { CompanyBoxOption } from "./company-jobs-model.js";

const NOW = Date.parse("2026-10-18T15:00:00.000Z");
const CRON = "cron(0 9 ? * MON-FRI *)";
const BOXES: CompanyBoxOption[] = [
  { id: "opc_1", name: "main" },
  { id: "opc_2", name: "other" },
];

function definition(name: string, prompt = "Write the weekday note."): Record<string, unknown> {
  return {
    prompt,
    context: { name },
    schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" },
  };
}

describe("US-004 company jobs screen", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
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

  function setValue(target: HTMLElement, testid: string, value: string): void {
    const el = target.querySelector(`[data-testid='${testid}']`);
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      throw new Error(`missing ${testid}`);
    }
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
  }

  function choose(target: HTMLElement, testid: string, value: string): void {
    const button = target.querySelector(`[data-testid='${testid}']`);
    if (!(button instanceof HTMLButtonElement)) throw new Error(`missing ${testid}`);
    button.click();
    flushSync();
    const option = [...target.querySelectorAll(`[data-testid='${testid}-menu'] [data-value]`)].find(
      (el) => el.getAttribute("data-value") === value,
    );
    if (!(option instanceof HTMLElement)) throw new Error(`missing ${testid} option ${value}`);
    option.click();
    flushSync();
  }

  it("asks for a company before it reads jobs", async () => {
    const store = createCompanyJobStore();
    const target = mountPage({ companyUid: null, role: "admin", client: store.client({ uid: "prs_a", role: "admin" }) });
    await ready(target);
    expect(target.querySelector("[data-testid='company-jobs-empty']")?.textContent).toContain("Choose a company to see its jobs.");
    expect(store.requests).toHaveLength(0);
    expect(target.querySelector("[data-testid='company-jobs-page']")?.getAttribute("data-route")).toBe("outpost-jobs");
  });

  it("validates inline, then submits an accepted revision in plain words", async () => {
    const store = createCompanyJobStore();
    const client = store.client({ uid: "prs_a", role: "admin" });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    await ready(target);
    expect(target.querySelector("[data-testid='company-jobs-empty']")?.textContent).toContain("No scheduled jobs yet.");
    (target.querySelector("[data-testid='company-jobs-add']") as HTMLButtonElement).click();
    flushSync();
    const before = store.requests.length;
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-name-error']")?.textContent).toBe("Enter a job name.");
    expect(target.querySelector("[data-testid='company-jobs-run-error']")?.textContent).toBe("Describe what this job runs.");
    expect(target.querySelector("[data-testid='company-jobs-box-error']")?.textContent).toBe("Choose an Outpost.");
    expect(store.requests).toHaveLength(before);

    setValue(target, "company-jobs-name", "Weekday note");
    setValue(target, "company-jobs-run", "Write the weekday note.");
    choose(target, "company-jobs-box", "opc_1");
    expect(target.querySelector("[data-testid='company-jobs-schedule-plain']")?.textContent).toBe("Every weekday at 9:00");
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    await ready(target);
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-row']")?.textContent).toContain("Weekday note");
    });
    const create = store.requests.find((row) => row.body?.action === "create");
    expect(JSON.stringify(create?.body)).not.toMatch(/registered_by|notify/);
    expect(target.querySelector("[data-testid='company-jobs-waiting']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Unknown");
    expect(target.querySelector("[data-testid='company-jobs-health']")?.textContent).not.toContain("Ran on time");
  });

  it("fills the watchdog template and still lets every field change", async () => {
    const store = createCompanyJobStore();
    const target = mountPage({
      companyUid: "cmp_1",
      role: "admin",
      client: store.client({ uid: "prs_a", role: "admin" }),
    });
    await ready(target);
    (target.querySelector("[data-testid='company-jobs-watchdog']") as HTMLButtonElement).click();
    flushSync();
    const name = target.querySelector("[data-testid='company-jobs-name']");
    expect(name).toBeInstanceOf(HTMLInputElement);
    expect((name as HTMLInputElement).value).toBe("watchdog-refresh");
    expect(target.querySelector("[data-testid='company-jobs-schedule-plain']")?.textContent).toBe("Every day at 8:00 and 20:00");
    expect(target.querySelector("[data-testid='company-jobs-alert']")?.getAttribute("data-value")).toBe("admins");
    setValue(target, "company-jobs-name", "watchdog-edited");
    expect((target.querySelector("[data-testid='company-jobs-name']") as HTMLInputElement).value).toBe("watchdog-edited");
    choose(target, "company-jobs-box", "opc_1");
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(store.jobs[0]?.name).toBe("watchdog-edited"));
    expect(store.jobs[0]?.cron).toBe("cron(0 8,20 ? * * *)");
    expect(store.jobs[0]?.registeredBy).toBe("prs_a");
  });

  it("loads the company Outpost list when the page is not given boxes", async () => {
    const store = createCompanyJobStore();
    const target = mountPage({
      companyUid: "cmp_1",
      role: "admin",
      boxes: undefined,
      client: store.client({ uid: "prs_a", role: "admin" }),
      api: {
        listCompanyOutposts: async () => ({
          ok: true as const,
          value: {
            outposts: [
              { outpostId: "opc_9", name: "ridge", lifecycle: "ready" },
              { outpostId: "opc_old", name: "gone", lifecycle: "destroyed" },
            ],
          },
        }),
      },
    });
    await ready(target);
    const filterButton = target.querySelector("[data-testid='company-jobs-box-filter']");
    expect(filterButton).toBeInstanceOf(HTMLButtonElement);
    (filterButton as HTMLButtonElement).click();
    flushSync();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-box-filter-menu']")?.textContent).toContain("ridge");
    });
    expect(target.querySelector("[data-testid='company-jobs-box-filter-menu']")?.textContent).not.toContain("gone");
    (filterButton as HTMLButtonElement).click();
    flushSync();
    (target.querySelector("[data-testid='company-jobs-add']") as HTMLButtonElement).click();
    flushSync();
    (target.querySelector("[data-testid='company-jobs-box']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-box-menu']")?.textContent).toContain("ridge");
  });

  it("shows waiting for an admin and no run controls when the revision is not accepted", async () => {
    const store = createCompanyJobStore({ autoAccept: false });
    const client = store.client({ uid: "prs_a", role: "admin" });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    await ready(target);
    (target.querySelector("[data-testid='company-jobs-add']") as HTMLButtonElement).click();
    flushSync();
    setValue(target, "company-jobs-name", "Pending note");
    setValue(target, "company-jobs-run", "Wait for review.");
    choose(target, "company-jobs-box", "opc_1");
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(target.querySelector("[data-testid='company-jobs-waiting']")?.textContent).toBe("Waiting for an admin");
    });
    expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-run-now']")).toBeNull();
    expect(store.runnablePrompts()).toEqual([]);
  });

  it("lets an admin pause, resume, edit, run, and remove a job", async () => {
    const store = createCompanyJobStore();
    const client = store.client({ uid: "prs_a", role: "admin" });
    await client.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-pause']")).toBeTruthy());

    (target.querySelector("[data-testid='company-jobs-pause']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-resume']")).toBeTruthy());
    expect(target.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Paused");
    expect(target.querySelector("[data-testid='company-jobs-next']")?.textContent).toBe("Paused");
    expect(target.querySelector("[data-testid='company-jobs-run-now']")).toBeNull();

    (target.querySelector("[data-testid='company-jobs-resume']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-run-now']")).toBeTruthy());
    (target.querySelector("[data-testid='company-jobs-run-now']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(store.runs).toHaveLength(1));
    expect(store.runs[0]?.actor).toBe("prs_a");

    (target.querySelector("[data-testid='company-jobs-edit']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-submit']")?.textContent).toBe("Save job");
    setValue(target, "company-jobs-name", "Edited note");
    (target.querySelector("[data-testid='company-jobs-submit']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-row']")?.textContent).toContain("Edited note"));

    (target.querySelector("[data-testid='company-jobs-remove']") as HTMLButtonElement).click();
    flushSync();
    expect(store.jobs[0]?.deleted).not.toBe(true);
    (target.querySelector("[data-testid='company-jobs-remove-confirm']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-row']")).toBeNull());
    expect(store.jobs[0]?.deleted).toBe(true);
  });

  it("hides manage controls from a member", async () => {
    const store = createCompanyJobStore();
    const admin = store.client({ uid: "prs_a", role: "admin" });
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
    const target = mountPage({
      companyUid: "cmp_1",
      role: "member",
      client: store.client({ uid: "prs_m", role: "member" }, { writesAllowed: false, memberRead: true }),
    });
    await ready(target);
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-row']")).toBeTruthy());
    expect(target.querySelector("[data-testid='company-jobs-member-note']")?.textContent).toContain("Only owners and admins can change it.");
    for (const id of ["company-jobs-add", "company-jobs-watchdog", "company-jobs-pause", "company-jobs-edit", "company-jobs-remove", "company-jobs-run-now"]) {
      expect(target.querySelector(`[data-testid='${id}']`), id).toBeNull();
    }
  });

  it("ignores a slow list once a newer box filter has loaded", async () => {
    const store = createCompanyJobStore();
    const admin = store.client({ uid: "prs_a", role: "admin" });
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("One") });
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_2", definition: definition("Two") });
    const pending: Array<(value: JobsListResult) => void> = [];
    const client: CompanyJobsClient = {
      list: (company, box) => {
        if (!box) return new Promise<JobsListResult>((resolve) => pending.push(() => resolve(admin.list(company, box))));
        return admin.list(company, box);
      },
      status: (company, box) => admin.status(company, box),
      submit: (input) => admin.submit(input),
    };
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client });
    choose(target, "company-jobs-box-filter", "opc_2");
    await vi.waitFor(() => expect(target.textContent).toContain("Two"));
    expect(target.textContent).not.toContain("One");
    pending.forEach((release) => release(undefined as unknown as JobsListResult));
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    expect(target.textContent).toContain("Two");
    expect(target.textContent).not.toContain("One");
  });
});

describe("US-006 company job health on the screen", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
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

  it("shows missed, stale, blocked, unknown, and paused without calling unknown ok", async () => {
    const store = createCompanyJobStore();
    const admin = store.client({ uid: "prs_a", role: "admin" });
    const names = ["On time", "Missed job", "Blocked job", "Stale job", "Unknown job"] as const;
    const health = ["ok", "missed", "blocked", "stale", "unknown"] as const;
    for (let index = 0; index < names.length; index += 1) {
      const created = await admin.submit({
        companyUid: "cmp_1",
        action: "create",
        outpostId: "opc_1",
        definition: definition(names[index], `Prompt ${index}`),
      });
      if (!created.ok || !created.job) throw new Error("create failed");
      store.setHealth(created.job.jobId, {
        health: health[index],
        lastRunAt: index === 4 ? null : "2026-10-18T14:00:00.000Z",
        nextRunAt: "2026-10-18T16:00:00.000Z",
        message: index === 1 ? "No completion arrived." : "",
      });
    }
    const paused = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Paused job"),
    });
    if (!paused.ok || !paused.job) throw new Error("create failed");
    await admin.submit({
      companyUid: "cmp_1",
      action: "disable",
      jobId: paused.job.jobId,
      revision: paused.job.revision,
    });
    store.setHealth(paused.job.jobId, { health: "ok", lastRunAt: "2026-10-18T14:00:00.000Z", message: "Paused on purpose." });

    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    const row = (name: string) => [...target.querySelectorAll("[data-testid='company-jobs-row']")].find((item) => item.textContent?.includes(name));
    expect(row("On time")?.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Ran on time");
    expect(row("On time")?.querySelector("[data-testid='company-jobs-last']")?.textContent).toBe("1h ago");
    expect(row("On time")?.querySelector("[data-testid='company-jobs-next']")?.textContent).toBe("in 1h");
    expect(row("Missed job")?.querySelector("[data-testid='company-jobs-missed']")?.textContent).toBe("Missed");
    expect(row("Stale job")?.querySelector("[data-testid='company-jobs-stale']")?.textContent).toBe("Out of date");
    expect(row("Blocked job")?.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Blocked");
    const unknown = row("Unknown job")?.querySelector("[data-testid='company-jobs-health']")?.textContent ?? "";
    expect(unknown).toContain("Unknown");
    expect(unknown).not.toContain("Ran on time");
    expect(row("Unknown job")?.querySelector("[data-testid='company-jobs-last']")?.textContent).toBe("Never");
    expect(row("Paused job")?.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Paused");
    expect(row("Paused job")?.textContent).not.toContain("Ran on time");

    (row("Missed job")?.querySelector("[data-testid='company-jobs-log']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-log-panel']")?.textContent).toContain("No completion arrived.");
    (target.querySelector("[data-testid='company-jobs-log-close']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-log-panel']")).toBeNull();
  });

  it("keeps the list when health fails and shows a load error only when the list fails too", async () => {
    const store = createCompanyJobStore();
    const admin = store.client({ uid: "prs_a", role: "admin" });
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Weekday note") });
    store.failStatus = true;
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    await vi.waitFor(() => expect(target.textContent).toContain("Weekday note"));
    expect(target.querySelector("[data-testid='company-jobs-load-error']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-health']")?.textContent).toContain("Unknown");

    store.failList = true;
    store.failStatus = true;
    const filterButton = target.querySelector("[data-testid='company-jobs-box-filter']");
    if (!(filterButton instanceof HTMLButtonElement)) throw new Error("missing box filter");
    filterButton.click();
    flushSync();
    const option = [...target.querySelectorAll("[data-testid='company-jobs-box-filter-menu'] [data-value]")].find(
      (el) => el.getAttribute("data-value") === "opc_2",
    );
    if (!(option instanceof HTMLElement)) throw new Error("missing opc_2");
    option.click();
    flushSync();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-load-error']")?.textContent).toContain("Could not load. Retry"));
    store.failList = false;
    store.failStatus = false;
    (target.querySelector("[data-testid='company-jobs-try-again']") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(target.querySelector("[data-testid='company-jobs-load-error']")).toBeNull());
  });

  it("shows health rows when the list is refused and the status read works", async () => {
    const store = createCompanyJobStore();
    const admin = store.client({ uid: "prs_a", role: "admin" });
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition("Weekday note"),
    });
    if (!created.ok || !created.job) throw new Error("create failed");
    store.setHealth(created.job.jobId, { health: "missed", message: "Missed the window." });
    store.failList = true;
    const target = mountPage({ companyUid: "cmp_1", role: "admin", client: admin });
    await ready(target);
    expect(target.querySelector("[data-testid='company-jobs-load-error']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-missed']")?.textContent).toBe("Missed");
  });

  it("shows the no-access note instead of a load error when both reads are refused", async () => {
    const store = createCompanyJobStore();
    const target = mountPage({
      companyUid: "cmp_1",
      role: "member",
      client: store.client({ uid: "prs_m", role: "member" }, { writesAllowed: false, memberRead: false }),
    });
    await ready(target);
    expect(target.querySelector("[data-testid='company-jobs-read-denied']")?.textContent).toBe(
      "You do not have access to this company's Outposts.",
    );
    expect(target.querySelector("[data-testid='company-jobs-member-note']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-load-error']")).toBeNull();
    expect(target.querySelector("[data-testid='company-jobs-add']")).toBeNull();
  });

  it("shows the blocked box note for the selected box", async () => {
    const store = createCompanyJobStore();
    const boxes = [
      { id: "opc_1", name: "main", blocked: true },
      { id: "opc_2", name: "other" },
    ];
    const target = mountPage({
      companyUid: "cmp_1",
      role: "admin",
      boxes,
      client: store.client({ uid: "prs_a", role: "admin" }),
    });
    await ready(target);
    expect(target.querySelector("[data-testid='company-jobs-blocked-note']")).toBeNull();
    (target.querySelector("[data-testid='company-jobs-box-filter']") as HTMLButtonElement).click();
    flushSync();
    const blockedOption = [...target.querySelectorAll("[data-testid='company-jobs-box-filter-menu'] [data-value]")].find(
      (el) => el.getAttribute("data-value") === "opc_1",
    );
    if (!(blockedOption instanceof HTMLElement)) throw new Error("missing opc_1");
    blockedOption.click();
    flushSync();
    expect(target.querySelector("[data-testid='company-jobs-blocked-note']")?.textContent).toContain("HQ has been notified and will follow up by email.");

    if (component) await unmount(component);
    component = null;
    const memberTarget = document.createElement("div");
    document.body.appendChild(memberTarget);
    component = mount(CompanyJobsPage, {
      target: memberTarget,
      props: {
        now: NOW,
        companyUid: "cmp_1",
        role: "member",
        boxes: [{ id: "opc_1", name: "main", stopped: true }],
        outpostId: "opc_1",
        client: store.client({ uid: "prs_m", role: "member" }, { memberRead: true, writesAllowed: false }),
      },
    });
    flushSync();
    await vi.waitFor(() => {
      expect(memberTarget.querySelector("[data-testid='company-jobs-blocked-note']")?.textContent).toContain(
        "This Outpost is stopped. Scheduled jobs are paused until it is started.",
      );
    });
  });
});
