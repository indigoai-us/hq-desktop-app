/**
 * In-memory company Outpost client for tests and the preview harness.
 * No network, no charge. A failure or a pending result does not add a row.
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
  chargeCount(): number;
  signInCount(): number;
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
  priceHint?: string | null;
  cap?: number;
  plan?: readonly ProvisionResult[];
  listError?: ListResult;
}): CompanyOutpostStub {
  const canManage = options.canManage ?? canManageRole(options.role ?? "admin");
  const priceHint = options.priceHint === undefined ? null : options.priceHint;
  const cap = options.cap ?? COMPANY_OUTPOST_CAP;
  let rows = (options.items ?? []).map(cloneDetail);
  let charges = 0;
  let signIns = 0;
  let planIndex = 0;
  const refusal: ManageResult = { ok: false, message: "Only company owners and admins can manage Outposts." };

  function consume(): ProvisionResult {
    const plan = options.plan ?? [];
    const result = plan[planIndex] ?? { status: "failure", charged: false, message: failureCopy(false) };
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
    if (result.status === "failure" && result.charged) charges += 1;
    return result;
  }

  return {
    readItems: () => rows.map(toItem),
    chargeCount: () => charges,
    signInCount: () => signIns,
    async list() {
      if (options.listError) return options.listError;
      return { ok: true, items: rows.map(toItem), priceHint, cap };
    },
    async detail(outpostId) {
      const row = rows.find((item) => item.id === outpostId);
      if (!row) return { ok: false, message: "Could not load. Retry." };
      return { ok: true, outpost: cloneDetail(row) };
    },
    previewAdd(existingNames) {
      return { name: nextOutpostName(existingNames), priceHint, cap };
    },
    async provision() {
      if (!canManage) return { status: "forbidden" };
      return consume();
    },
    async pollProvision() {
      if (!canManage) return { status: "forbidden" };
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
    async signInAgain(outpostId) {
      if (!canManage) return refusal;
      if (!rows.some((item) => item.id === outpostId)) return { ok: false, message: "Could not start sign-in again." };
      signIns += 1;
      return { ok: true, message: "Sign-in again was requested for this Outpost. This screen does not open a sign-in page." };
    },
  };
}

export function blankHealth() {
  return emptyHealth();
}
