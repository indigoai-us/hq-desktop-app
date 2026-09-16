/**
 * Where an in-channel "Session" click should bind the live agent session.
 *
 * The native spawn always runs from the HQ root; company/project are context
 * for the first turn, not a launch requirement. Requiring both used to drop
 * the click on #welcome (no company on the row) and on a company that has
 * not created a project yet — the pane went idle with no error.
 */

import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";
import { projectIdForRow } from "./live-channel-tabs.js";

export interface LiveSessionStartTarget {
  companySlug: string;
  projectId: string;
}

function slugOf(
  company: Workspace | undefined,
): string {
  return (company?.slug ?? "").trim();
}

/**
 * Resolve the company/project the host should hand to `onstartlivesession`.
 *
 * Prefers the selected row's company. When the row is company-less (#welcome,
 * a personal DM), falls back to the first company on the roster so a person
 * who already belongs to one can still start a session from that pane.
 * `projectId` may be empty — a company with no projects is still a valid start.
 */
export function liveSessionStartTarget(
  row: ConversationRow | null | undefined,
  companies: readonly Workspace[] | null | undefined,
): LiveSessionStartTarget {
  const projectId = projectIdForRow(row ?? null);
  const roster = companies ?? [];
  const companyUid = (row?.companyUid ?? "").trim();
  if (companyUid) {
    const fromRow = roster.find(
      (company) => (company.cloudUid ?? "").trim() === companyUid,
    );
    const slug = slugOf(fromRow);
    if (slug) return { companySlug: slug, projectId };
  }
  const fallback = roster.find(
    (company) => company.kind === "company" && slugOf(company).length > 0,
  );
  return { companySlug: slugOf(fallback), projectId };
}
