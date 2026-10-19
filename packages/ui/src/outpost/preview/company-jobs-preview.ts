/**
 * Fixture preview for headless screenshots. Nothing here calls a real service.
 */
import { mount } from "svelte";
import CompanyJobsPage from "../CompanyJobsPage.svelte";
import { createCompanyJobStore } from "../company-jobs-stub.js";
import type { CompanyBoxOption, CompanyJobRole } from "../company-jobs-model.js";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const shot = params.get("shot") ?? "list";
document.documentElement.dataset.forceTheme = theme;
document.documentElement.dataset.windowTransparency = "0";
document.documentElement.style.colorScheme = theme;

const NOW = Date.parse("2026-10-18T15:00:00.000Z");
const CRON = "cron(0 9 ? * MON-FRI *)";
const boxes: CompanyBoxOption[] = [
  { id: "opc_1", name: "main", blocked: shot === "blocked" },
  { id: "opc_2", name: "other" },
];

const store = createCompanyJobStore({ now: () => "2026-10-18T15:00:00.000Z", autoAccept: shot !== "waiting" });
const admin = store.client({ uid: "prs_admin", role: "admin" });

function definition(name: string, prompt: string): Record<string, unknown> {
  return { prompt, context: { name }, schedule: { kind: "recurring", cron: CRON, timezone: "America/New_York" } };
}

const notAvailable = shot === "not-available" || shot === "not-available-member";

async function seed(): Promise<void> {
  if (notAvailable) {
    store.failCode = "billing_required";
    return;
  }
  if (shot === "empty-admin" || shot === "empty-member" || shot === "add" || shot === "watchdog" || shot === "invalid" || shot === "load-error") {
    return;
  }
  if (shot === "waiting") {
    await admin.submit({ companyUid: "cmp_1", action: "create", outpostId: "opc_1", definition: definition("Pending note", "Wait for an admin.") });
    return;
  }
  const rows: Array<{ name: string; health: "ok" | "missed" | "blocked" | "stale" | "unknown"; message?: string }> = shot === "list" || shot === "log" || shot === "member"
    ? [
        { name: "Weekday note", health: "ok" },
        { name: "Missed refresh", health: "missed", message: "No completion arrived." },
        { name: "Blocked publish", health: "blocked", message: "The last run was blocked." },
        { name: "Stale ledger", health: "stale", message: "The job completed but its data did not advance." },
        { name: "Unknown check", health: "unknown" },
      ]
    : [{ name: "Weekday note", health: "ok" }];
  for (const row of rows) {
    const created = await admin.submit({
      companyUid: "cmp_1",
      action: "create",
      outpostId: "opc_1",
      definition: definition(row.name, `Run ${row.name}.`),
    });
    if (!created.ok || !created.job) continue;
    store.setHealth(created.job.jobId, {
      health: row.health,
      lastRunAt: row.health === "unknown" ? null : "2026-10-18T14:00:00.000Z",
      nextRunAt: "2026-10-18T16:00:00.000Z",
      message: row.message ?? "",
    });
    if (shot === "paused" && row.name === "Weekday note") {
      await admin.submit({ companyUid: "cmp_1", action: "disable", jobId: created.job.jobId, revision: created.job.revision });
      store.setHealth(created.job.jobId, { health: "ok", message: "Paused on purpose." });
    }
  }
  if (shot === "load-error") store.failList = true;
}

function roleFor(name: string): CompanyJobRole {
  if (name === "empty-member" || name === "member" || name === "not-available-member") return "member";
  return "admin";
}

await seed();
if (shot === "load-error") {
  store.failList = true;
  store.failStatus = true;
}
const client = roleFor(shot) === "member"
  ? store.client({ uid: "prs_member", role: "member" }, { writesAllowed: false, memberRead: shot !== "load-error" })
  : admin;

const app = document.getElementById("app");
if (!app) throw new Error("missing app");
mount(CompanyJobsPage, {
  target: app,
  props: {
    now: NOW,
    companyUid: "cmp_1",
    role: roleFor(shot),
    boxes: shot === "blocked" ? [{ id: "opc_1", name: "main", blocked: true }] : boxes,
    outpostId: shot === "blocked" ? "opc_1" : null,
    client,
    contact: async () => ({ ok: true as const, value: {} }),
  },
});

async function waitFor(selector: string, timeout = 4000): Promise<Element | null> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = document.querySelector(selector);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return document.querySelector(selector);
}

async function settle(): Promise<void> {
  await waitFor("[data-testid='company-jobs-page'][data-ready='true']");
  if (shot === "add" || shot === "invalid") {
    document.querySelector<HTMLButtonElement>("[data-testid='company-jobs-add']")?.click();
    await waitFor("[data-testid='company-jobs-form']");
  }
  if (shot === "watchdog") {
    document.querySelector<HTMLButtonElement>("[data-testid='company-jobs-watchdog']")?.click();
    await waitFor("[data-testid='company-jobs-form']");
  }
  if (shot === "log") {
    document.querySelector<HTMLButtonElement>("[data-testid='company-jobs-log']")?.click();
    await waitFor("[data-testid='company-jobs-log-panel']");
  }
  if (shot === "invalid") {
    const name = document.querySelector<HTMLInputElement>("[data-testid='company-jobs-name']");
    if (name) {
      name.value = "!!!";
      name.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.querySelector<HTMLButtonElement>("[data-testid='company-jobs-submit']")?.click();
    await waitFor("[data-testid='company-jobs-name-error']");
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  document.documentElement.dataset.shotReady = "true";
}

void settle();
