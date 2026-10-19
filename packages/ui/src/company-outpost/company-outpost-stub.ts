/**
 * In-memory company Outpost client for tests and the preview harness.
 * No network. A failure or a pending result does not add a row.
 */
import {
  COMPANY_OUTPOST_CAP,
  canManageRole,
  emptyHealth,
  failureCopy,
  nextOutpostName,
  renameError,
  type CompanyOutpostDetail,
  type CompanyOutpostListItem,
  type CompanyOutpostRole,
  type ProvisionResult,
} from "./company-outpost-model.js";
import type { CompanyOutpostClient, ListResult, ManageResult } from "./company-outpost-client.js";

export interface CompanyOutpostStub extends CompanyOutpostClient {
  readItems(): CompanyOutpostListItem[];
  pollArgs(): string[];
  listCount(): number;
}

function cloneDetail(detail: CompanyOutpostDetail): CompanyOutpostDetail {
  return {
    ...detail,
    jobHealth: { ...detail.jobHealth },
    machine: { ...detail.machine },
    jobs: detail.jobs.map((job) => ({ ...job })),
    runs: detail.runs.map((run) => ({ ...run })),
  };
}

function toItem(detail: CompanyOutpostDetail): CompanyOutpostListItem {
  return {
    id: detail.id,
    name: detail.name,
    state: detail.state,
    lastSeenAt: detail.lastSeenAt,
    jobsCount: detail.jobsCount,
    jobHealth: { ...detail.jobHealth },
  };
}

export function createCompanyOutpostStub(options: {
  role?: CompanyOutpostRole;
  canManage?: boolean;
  items?: readonly CompanyOutpostDetail[];
  cap?: number;
  plan?: readonly ProvisionResult[];
  listError?: ListResult;
}): CompanyOutpostStub {
  const canManage = options.canManage ?? canManageRole(options.role ?? "admin");
  const cap = options.cap ?? COMPANY_OUTPOST_CAP;
  let rows = (options.items ?? []).map(cloneDetail);
  const polls: string[] = [];
  let lists = 0;
  let planIndex = 0;
  const refusal: ManageResult = { ok: false, message: "Only company owners and admins can manage Outposts." };

  function consume(): ProvisionResult {
    const plan = options.plan ?? [];
    const result = plan[planIndex] ?? { status: "failure", message: failureCopy() };
    if (planIndex < plan.length) planIndex += 1;
    if (result.status === "success") {
      const existing = rows.find((row) => row.id === result.outpost.id);
      if (!existing) {
        rows.push({
          ...result.outpost,
          jobHealth: { ...result.outpost.jobHealth },
          machine: { region: "US East", instanceId: "i-new", createdAt: "2026-10-18" },
          jobs: [],
          runs: [],
          stopped: false,
        });
      }
    }
    return result;
  }

  return {
    readItems: () => rows.map(toItem),
    pollArgs: () => [...polls],
    listCount: () => lists,
    async list() {
      lists += 1;
      if (options.listError) return options.listError;
      return { ok: true, items: rows.map(toItem), cap };
    },
    async detail(outpostId) {
      const row = rows.find((item) => item.id === outpostId);
      if (!row) return { ok: false, message: "Could not load. Retry." };
      return { ok: true, outpost: cloneDetail(row) };
    },
    previewAdd(existingNames) {
      return { name: nextOutpostName(existingNames), cap };
    },
    async provision() {
      if (!canManage) return { status: "forbidden" };
      return consume();
    },
    async pollProvision(attemptId) {
      if (!canManage) return { status: "forbidden" };
      polls.push(attemptId);
      return consume();
    },
    async rename(outpostId, name) {
      if (!canManage) return refusal;
      const error = renameError(name);
      if (error) return { ok: false, message: error };
      const row = rows.find((item) => item.id === outpostId);
      if (!row) return { ok: false, message: "Could not rename this Outpost." };
      row.name = name.trim();
      return { ok: true, message: "Name saved." };
    },
    async remove(outpostId) {
      if (!canManage) return refusal;
      const before = rows.length;
      rows = rows.filter((item) => item.id !== outpostId);
      if (rows.length === before) return { ok: false, message: "Could not remove this Outpost." };
      return { ok: true, message: "Outpost removed." };
    },
  };
}

export function blankHealth() {
  return emptyHealth();
}
