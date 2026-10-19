/**
 * Fixture boxes for tests and headless screenshots. No secrets.
 */
import {
  emptyHealth,
  failureCopy,
  type CompanyOutpostDetail,
  type JobHealthCounts,
} from "./company-outpost-model.js";
import { createCompanyOutpostStub, type CompanyOutpostStub } from "./company-outpost-stub.js";
import type { CompanyOutpostRole, ProvisionResult } from "./company-outpost-model.js";

export const FIXTURE_NOW = Date.parse("2026-10-18T16:00:00.000Z");

function health(partial: Partial<JobHealthCounts>): JobHealthCounts {
  return { ...emptyHealth(), ...partial };
}

export function fixtureOutpost(partial: Partial<CompanyOutpostDetail> & Pick<CompanyOutpostDetail, "id" | "name" | "state">): CompanyOutpostDetail {
  return {
    lastSeenAt: "2026-10-18T15:00:00.000Z",
    jobsCount: partial.jobs?.length ?? 0,
    jobHealth: partial.jobHealth ?? health({}),
    machine: { region: "US East", instanceId: "i-0abc", createdAt: "October 17, 2026" },
    jobs: [],
    runs: [],
    stopped: false,
    ...partial,
  };
}

export const FIXTURE_BOXES: CompanyOutpostDetail[] = [
  fixtureOutpost({
    id: "demo-1",
    name: "main",
    state: "running",
    jobsCount: 2,
    jobHealth: health({ ok: 1, missed: 1 }),
    jobs: [
      { id: "daily-digest", name: "daily-digest", health: "ok", lastRunAt: "2026-10-18T15:00:00.000Z", nextRunAt: "2026-10-19T15:00:00.000Z", summary: "Summarize the company updates." },
      { id: "report-check", name: "report-check", health: "missed", lastRunAt: "2026-10-18T14:00:00.000Z", nextRunAt: null, summary: "Check the report for missing sections." },
    ],
    runs: [
      { id: "daily-digest@1", jobId: "daily-digest", jobName: "daily-digest", at: "2026-10-18T15:00:00.000Z", health: "ok" },
      { id: "report-check@1", jobId: "report-check", jobName: "report-check", at: "2026-10-18T14:00:00.000Z", health: "missed" },
    ],
  }),
  fixtureOutpost({
    id: "demo-2",
    name: "bright-maple",
    state: "preparing",
    lastSeenAt: null,
    jobsCount: 0,
    machine: { region: "", instanceId: "", createdAt: "October 18, 2026" },
  }),
  fixtureOutpost({
    id: "demo-3",
    name: "gentle-brook",
    state: "needs_attention",
    stopped: true,
    jobsCount: 1,
    jobHealth: health({ stale: 1 }),
    jobs: [
      { id: "weekly-summary", name: "weekly-summary", health: "stale", lastRunAt: "2026-10-12T16:00:00.000Z", nextRunAt: null, summary: "Summarize completed work." },
    ],
    runs: [
      { id: "weekly-summary@1", jobId: "weekly-summary", jobName: "weekly-summary", at: "2026-10-12T16:00:00.000Z", health: "stale" },
    ],
  }),
  fixtureOutpost({
    id: "demo-4",
    name: "silver-pine",
    state: "blocked",
    jobsCount: 1,
    jobHealth: health({ blocked: 1 }),
    jobs: [
      { id: "inbox-check", name: "inbox-check", health: "blocked", lastRunAt: "2026-10-18T13:00:00.000Z", nextRunAt: null, summary: "Check for new company requests." },
    ],
    runs: [
      { id: "inbox-check@1", jobId: "inbox-check", jobName: "inbox-check", at: "2026-10-18T13:00:00.000Z", health: "blocked" },
    ],
  }),
];

export interface PreviewSetup {
  role: CompanyOutpostRole;
  client: CompanyOutpostStub;
  initialScreen: "list" | "add" | "confirm" | "detail" | "remove" | "preparing" | "unavailable" | "job";
  initialOutpostId?: string;
  initialJobId?: string;
  initialNotice?: string;
}

const screens: Record<string, () => PreviewSetup> = {
  "admin-list": () => setup("admin", FIXTURE_BOXES, "list"),
  "member-list": () => setup("member", FIXTURE_BOXES, "list"),
  "empty-admin": () => setup("admin", [], "list"),
  "empty-member": () => setup("member", [], "list"),
  cap: () => setup("admin", [...FIXTURE_BOXES, fixtureOutpost({ id: "demo-5", name: "quiet-pine", state: "running" })], "list"),
  add: () => setup("admin", [], "add"),
  confirm: () => setup("admin", [], "confirm"),
  preparing: () => setup("admin", FIXTURE_BOXES, "preparing", { initialOutpostId: "demo-2" }),
  "unavailable-owner": () => setup("owner", [], "unavailable"),
  "unavailable-admin": () => setup("admin", [], "unavailable"),
  "detail-running": () => setup("admin", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-1" }),
  "detail-blocked-admin": () => setup("admin", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-4" }),
  "detail-blocked-member": () => setup("member", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-4" }),
  "detail-needs-attention": () => setup("admin", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-3" }),
  "detail-preparing": () => setup("member", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-2" }),
  remove: () => setup("admin", FIXTURE_BOXES, "remove", { initialOutpostId: "demo-1" }),
  failure: () => setup("admin", [FIXTURE_BOXES[0]!], "confirm", { initialNotice: failureCopy() }),
  "already-exists": () => setup("admin", [FIXTURE_BOXES[0]!], "confirm", { initialNotice: "An Outpost already exists for this company." }),
  "job-stub": () => setup("member", FIXTURE_BOXES, "job", { initialOutpostId: "demo-1", initialJobId: "daily-digest" }),
  "member-detail": () => setup("member", FIXTURE_BOXES, "detail", { initialOutpostId: "demo-1" }),
};

function setup(
  role: CompanyOutpostRole,
  items: CompanyOutpostDetail[],
  initialScreen: PreviewSetup["initialScreen"],
  extra: Partial<PreviewSetup> = {},
): PreviewSetup {
  return {
    role,
    client: createCompanyOutpostStub({ role, items, cap: 5 }),
    initialScreen,
    ...extra,
  };
}

export function companyOutpostPreview(screen: string): PreviewSetup {
  return (screens[screen] ?? screens["admin-list"]!)();
}

export const COMPANY_OUTPOST_SCREENS = Object.keys(screens);

export function successOutpost(): ProvisionResult {
  return {
    status: "success",
    outpost: {
      id: "demo-new",
      name: "quiet-pine",
      state: "preparing",
      lastSeenAt: null,
      jobsCount: 0,
      jobHealth: emptyHealth(),
    },
  };
}
