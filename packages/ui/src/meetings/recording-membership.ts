import type { Workspace } from "../chat/workspaces.js";
import type { CompanyMembership } from "./meetings-model.js";

/**
 * One authorization predicate for recording attribution. `accepted` is a
 * current granted membership in the desktop API and must not be displayed as
 * Personal while the Meetings action path accepts it.
 */
export function isRecordingMembershipStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return normalized === "active" || normalized === "accepted";
}

export function isRecordingWorkspace(workspace: Workspace): boolean {
  return (
    workspace.kind === "company" &&
    Boolean(workspace.cloudUid) &&
    isRecordingMembershipStatus(workspace.membershipStatus)
  );
}

export function isRecordingCompanyMembership(row: CompanyMembership): boolean {
  return isRecordingMembershipStatus(row.status);
}
