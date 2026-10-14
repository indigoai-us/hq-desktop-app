/**
 * Cross-company group grants for the company Grants pane: the same data and
 * actions as the web console's Grants page. Pure: no Svelte, no Tauri.
 *
 * Outbound grants (this company's groups granted a role on another company)
 * come from hq-pro GET /group-grants/outbound, read once per group. Inbound
 * grants (other companies' groups with a role here) come from GET
 * /group-grants/inbound. Grant and revoke are POST /group-grants and POST
 * /group-grants/revoke. Both lists return active and revoked rows; the pane
 * splits them by status.
 *
 * Owner decision 2026-10-07: cross-company grants are read or write, never
 * admin. hq-pro takes a membership role, so the pane offers the two
 * non-admin roles: member (write) and guest (read).
 */

import type { AdapterResult, GroupGrantInput, GroupGrantKey, Json } from "@hq/platform";
import type { CompanyGroup } from "./company-settings.js";

export type GroupGrantStatus = "active" | "pending" | "revoked";

export interface GroupGrant {
  groupId: string;
  sourceCompanyUid: string;
  targetCompanyUid: string;
  role: string;
  status: GroupGrantStatus;
  grantedAt: string | null;
  sourceCompanyName: string | null;
  targetCompanyName: string | null;
}

/** A company the caller may grant into. */
export interface GrantTarget {
  uid: string;
  label: string;
  /** Owner or admin there. Others are listed but cannot be picked. */
  eligible: boolean;
}

export interface GrantRoleOption {
  value: "member" | "guest";
  label: string;
}

/** Read or write only; admin is never offered for a cross-company grant. */
export const GRANT_ROLE_OPTIONS: readonly GrantRoleOption[] = [
  { value: "member", label: "Write" },
  { value: "guest", label: "Read" },
];

export const UNKNOWN_COMPANY = "Unknown company";

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function status(v: unknown): GroupGrantStatus {
  return v === "revoked" ? "revoked" : v === "pending" ? "pending" : "active";
}

/** Rows from `{ grants: [...] }`. Rows missing an id are dropped. */
export function groupGrantsFromBody(body: unknown): GroupGrant[] {
  const list = body && typeof body === "object" ? (body as { grants?: unknown }).grants : null;
  if (!Array.isArray(list)) throw new Error("group grants response did not parse");
  const out: GroupGrant[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const groupId = str(g.groupId);
    const sourceCompanyUid = str(g.sourceCompanyUid);
    const targetCompanyUid = str(g.targetCompanyUid);
    if (!groupId || !sourceCompanyUid || !targetCompanyUid) continue;
    out.push({
      groupId,
      sourceCompanyUid,
      targetCompanyUid,
      role: str(g.role) || "member",
      status: status(g.status),
      grantedAt: str(g.grantedAt) || null,
      sourceCompanyName: str(g.sourceCompanyName) || str(g.sourceCompanySlug) || null,
      targetCompanyName: str(g.targetCompanyName) || str(g.targetCompanySlug) || null,
    });
  }
  return out;
}

/** Plain role name: Write, Read, or the server's role for older rows. */
export function grantRoleLabel(role: string): string {
  const hit = GRANT_ROLE_OPTIONS.find((o) => o.value === role);
  if (hit) return hit.label;
  return role ? role[0]!.toUpperCase() + role.slice(1) : "Unknown";
}

/** A readable company name; ids and blanks read "Unknown company". */
export function companyName(name: string | null | undefined, uid: string, targets: readonly GrantTarget[] = []): string {
  const clean = (name ?? "").trim();
  if (clean && !clean.startsWith("cmp_")) return clean;
  const known = targets.find((t) => t.uid === uid)?.label?.trim();
  if (known && !known.startsWith("cmp_")) return known;
  return UNKNOWN_COMPANY;
}

export function groupName(groupId: string, groups: readonly CompanyGroup[]): string {
  return groups.find((g) => g.id === groupId)?.name ?? groupId;
}

export function splitByStatus(grants: readonly GroupGrant[]): { active: GroupGrant[]; revoked: GroupGrant[] } {
  return {
    active: grants.filter((g) => g.status !== "revoked"),
    revoked: grants.filter((g) => g.status === "revoked"),
  };
}

export function grantKey(g: GroupGrantKey): string {
  return `${g.sourceCompanyUid}:${g.groupId}:${g.targetCompanyUid}`;
}

export interface GrantForm {
  groupId: string;
  targetUids: readonly string[];
  role: string;
}

/** Why the grant cannot be sent yet, or null when it can. */
export function grantFormProblem(
  form: GrantForm,
  ctx: { currentUid: string; groups: readonly CompanyGroup[]; targets: readonly GrantTarget[] },
): string | null {
  if (ctx.groups.length === 0) return "This company has no groups yet. Create one first.";
  if (ctx.targets.length === 0) return "You have no other companies to grant access to.";
  if (!ctx.targets.some((t) => t.eligible)) return "Only owners and admins of the other company can grant access to it.";
  if (!form.groupId || !ctx.groups.some((g) => g.id === form.groupId)) return "Pick a group.";
  const picked = form.targetUids.filter((uid) => uid !== ctx.currentUid && ctx.targets.some((t) => t.uid === uid && t.eligible));
  if (picked.length === 0) return "Pick at least one company.";
  if (!GRANT_ROLE_OPTIONS.some((o) => o.value === form.role)) return "Pick Read or Write.";
  return null;
}

/** Plain copy for a failed grant, revoke, or read. Never the server's text. */
export function grantErrorCopy(failure: { code?: string; message?: string } | null | undefined, action: "grant" | "revoke" | "read"): string {
  const code = `${failure?.code ?? ""}`;
  if (/403|forbidden|denied/i.test(code)) {
    return action === "read"
      ? "Only owners and admins can see this."
      : "You need to be an owner or admin of that company to change its access.";
  }
  if (/404|GROUP_NOT_FOUND|not-found/i.test(code)) {
    return action === "revoke" ? "That grant no longer exists. The list has been refreshed." : "That group or company was not found.";
  }
  if (/429/.test(code)) return "HQ is busy. Wait a moment and try again.";
  if (/network|offline|timeout/i.test(code)) return "Could not reach HQ. Check your connection and try again.";
  if (action === "grant") return "Could not grant access.";
  if (action === "revoke") return "Could not revoke this grant.";
  return "Could not read grants.";
}

export interface GroupGrantsApi {
  listOutboundGroupGrants?(sourceCompanyUid: string, groupId: string): Promise<AdapterResult<Json>>;
  listInboundGroupGrants?(companyUid: string): Promise<AdapterResult<Json>>;
  createGroupGrant?(input: GroupGrantInput): Promise<AdapterResult<Json>>;
  revokeGroupGrant?(input: GroupGrantKey): Promise<AdapterResult<Json>>;
}

export type ListState = "ready" | "failed" | "forbidden";

export interface GroupGrantsRead {
  outbound: GroupGrant[];
  outboundState: ListState;
  /** Groups whose outbound read failed; their grants are missing, not zero. */
  outboundMissing: number;
  inbound: GroupGrant[];
  inboundState: ListState;
}

function failCode(res: AdapterResult<Json>): string {
  return res.ok ? "" : `${res.code ?? ""} ${res.message ?? ""}`;
}

/** Reads outbound grants for every group and inbound grants for the company. */
export async function readGroupGrants(opts: {
  api: GroupGrantsApi;
  companyUid: string;
  groups: readonly CompanyGroup[];
}): Promise<GroupGrantsRead> {
  const { api, companyUid, groups } = opts;
  const outbound: GroupGrant[] = [];
  let outboundMissing = 0;
  let forbidden = 0;
  const reads = await Promise.all(
    groups.map(async (g) => {
      try {
        return await api.listOutboundGroupGrants!(companyUid, g.id);
      } catch (err) {
        console.warn("[grants] outbound read threw", g.id, err);
        return null;
      }
    }),
  );
  for (const res of reads) {
    if (res?.ok) {
      try {
        outbound.push(...groupGrantsFromBody(res.value));
        continue;
      } catch (err) {
        console.warn("[grants] outbound response did not parse", err);
      }
    } else if (res) {
      console.warn("[grants] outbound read failed", res.code ?? res.message);
      if (/403/.test(failCode(res))) forbidden += 1;
    }
    outboundMissing += 1;
  }
  const outboundState: ListState =
    groups.length > 0 && outboundMissing === groups.length ? (forbidden === groups.length ? "forbidden" : "failed") : "ready";

  let inbound: GroupGrant[] = [];
  let inboundState: ListState = "ready";
  try {
    const res = await api.listInboundGroupGrants!(companyUid);
    if (res.ok) inbound = groupGrantsFromBody(res.value);
    else {
      console.warn("[grants] inbound read failed", res.code ?? res.message);
      inboundState = /403/.test(failCode(res)) ? "forbidden" : "failed";
    }
  } catch (err) {
    console.warn("[grants] inbound read failed", err);
    inboundState = "failed";
  }
  return { outbound, outboundState, outboundMissing: outboundState === "ready" ? outboundMissing : 0, inbound, inboundState };
}

export interface GrantOutcome {
  uid: string;
  ok: boolean;
  error: string | null;
}

/** Grants one group to each picked company. One failure does not stop the rest. */
export async function submitGrants(opts: {
  api: GroupGrantsApi;
  sourceCompanyUid: string;
  groupId: string;
  targetUids: readonly string[];
  role: string;
}): Promise<GrantOutcome[]> {
  const { api, sourceCompanyUid, groupId, targetUids, role } = opts;
  return Promise.all(
    targetUids.map(async (uid): Promise<GrantOutcome> => {
      try {
        const res = await api.createGroupGrant!({ groupId, sourceCompanyUid, targetCompanyUid: uid, role });
        if (res.ok) return { uid, ok: true, error: null };
        console.warn("[grants] grant failed", uid, res.code ?? res.message);
        return { uid, ok: false, error: grantErrorCopy(res, "grant") };
      } catch (err) {
        console.warn("[grants] grant threw", uid, err);
        return { uid, ok: false, error: grantErrorCopy({ code: "network" }, "grant") };
      }
    }),
  );
}

/** One line for a grant fan-out, or null when every company succeeded. */
export function grantOutcomeSummary(outcomes: readonly GrantOutcome[], targets: readonly GrantTarget[]): string | null {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return null;
  const ok = outcomes.length - failed.length;
  const detail = failed.map((f) => `${companyName(null, f.uid, targets)}: ${f.error}`).join(" ");
  return ok > 0 ? `Granted to ${ok} of ${outcomes.length} companies. ${detail}` : detail;
}
