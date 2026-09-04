import { roleIsAdminOrOwner, type WorkspaceLike } from "../chat/channel-admin.js";
import { isAgentUid } from "../chat/agent-thinking.js";
import { selfIsAdmin } from "../identity/self.js";

export function canEditAgentProfile(input: {
  agentUid?: string | null;
  agentCompanyUid?: string | null;
  companies?: ReadonlyArray<WorkspaceLike> | null;
  isAdmin?: boolean | null;
}): boolean {
  if (!isAgentUid(input.agentUid ?? "")) return false;
  if (typeof input.isAdmin === "boolean") return input.isAdmin;
  const companyUid = input.agentCompanyUid?.trim();
  if (companyUid) {
    const workspace = (input.companies ?? []).find(
      (row) => (row.cloudUid ?? "").trim() === companyUid,
    );
    if (workspace) return roleIsAdminOrOwner(workspace.role);
  }
  return selfIsAdmin(input.companies, input.isAdmin);
}

/**
 * Company-scoped owner/admin gate for "Move to another company" (US-017B).
 * Not channel selfIsOwner — same membership scope as canEditAgentProfile.
 */
export function canMigrateCompanySession(input: {
  companyUid?: string | null;
  companies?: ReadonlyArray<WorkspaceLike> | null;
}): boolean {
  const companyUid = input.companyUid?.trim();
  if (!companyUid) return false;
  const workspace = (input.companies ?? []).find(
    (row) => (row.cloudUid ?? "").trim() === companyUid,
  );
  if (!workspace) return false;
  const active =
    (workspace.membershipStatus ?? "active").toLowerCase() === "active";
  return active && roleIsAdminOrOwner(workspace.role);
}
