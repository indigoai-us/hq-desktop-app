/**
 * Company sidepane routing and counts (console-rail US-007).
 *
 * Every company sidepane row opens a company page. Pages that later stories
 * build replace their placeholder; until then the row lands on the same
 * placeholder frame the rail uses (US-003). Row counts come from the cached
 * company summary, so the pane paints from cache and refreshes in place.
 *
 * Pure data only, so it adds nothing to the boot path.
 */

import type { NavigationDestination } from "./navigation-history.js";
import {
  COMPANY_SETTINGS_ROW,
  COMPANY_SIDEPANE_SECTIONS,
  MANAGER_ONLY_ROWS,
  companySidepaneModel,
  type SidepaneCompany,
  type SidepaneListModel,
} from "./sidepane-models.js";

/** Extra-page ids for company sidepane destinations. */
export const COMPANY_PAGE_PREFIX = "company-page-";

export interface CompanyPagePlaceholder {
  id: string;
  title: string;
  /** Story that replaces the placeholder with the real page. */
  story: string;
  summary: string;
}

const PAGE_INFO: Record<string, { story: string; summary: string }> = {
  atlas: { story: "US-009", summary: "Who is live in this company and what they are working on." },
  projects: { story: "US-023", summary: "The company's projects and their stories." },
  activity: { story: "US-026", summary: "Recent work across the company." },
  team: { story: "US-027", summary: "People in this company and their access." },
  bots: { story: "US-027", summary: "Bots and agents in this company." },
  knowledge: { story: "US-028", summary: "The company's knowledge base." },
  policies: { story: "US-028", summary: "Rules that apply to work in this company." },
  skills: { story: "US-028", summary: "Skills available to this company." },
  workers: { story: "US-028", summary: "Workers from the company registry." },
  vault: { story: "US-029", summary: "Files in the company vault." },
  integrations: { story: "US-029", summary: "Apps connected to this company." },
  secrets: { story: "US-029", summary: "Company secrets, metadata only." },
  deployments: { story: "US-029", summary: "What this company has deployed or shared." },
  groups: { story: "OWNER-R24", summary: "Groups that share file and secret access." },
  grants: { story: "OWNER-R24", summary: "Folder grants and when they expire." },
  general: { story: "OWNER-R24", summary: "Company name, slug, and defaults for members." },
  brand: { story: "OWNER-R24", summary: "Accent color and voice." },
  billing: { story: "OWNER-R24", summary: "Plan, seats, and payment." },
};

const ROW_LABELS: ReadonlyMap<string, string> = new Map(
  COMPANY_SIDEPANE_SECTIONS.flatMap((s) => s.rows).map((r) => [r.id, r.label]),
);

/**
 * OWNER-R24: old routes kept as redirects. The Company settings page and its
 * own tabs are now panel panes; an old link lands on the pane it pointed at.
 */
export const LEGACY_COMPANY_ROWS: Readonly<Record<string, string>> = {
  [COMPANY_SETTINGS_ROW.id]: "general",
  workforce: "billing",
  // Goals left the sidebar; saved links to it open Atlas.
  goals: "atlas",
};

/** Every row id the company pane routes. */
export const COMPANY_PANE_ROW_IDS: readonly string[] = [...ROW_LABELS.keys()];

export function companyPageId(rowId: string): string {
  return `${COMPANY_PAGE_PREFIX}${LEGACY_COMPANY_ROWS[rowId] ?? rowId}`;
}

/** Row id for a company page id, or null when the page is not one. */
export function companyRowForPage(page: string | null | undefined): string | null {
  if (!page || !page.startsWith(COMPANY_PAGE_PREFIX)) return null;
  const raw = page.slice(COMPANY_PAGE_PREFIX.length);
  const id = LEGACY_COMPANY_ROWS[raw] ?? raw;
  return ROW_LABELS.has(id) ? id : null;
}

export function companyPagePlaceholderForPage(
  page: string | null | undefined,
): CompanyPagePlaceholder | null {
  const id = companyRowForPage(page);
  if (!id) return null;
  const info = PAGE_INFO[id];
  return { id, title: ROW_LABELS.get(id) ?? id, story: info.story, summary: info.summary };
}

export function companyRowDestination(
  rowId: string,
  companyUid: string,
): NavigationDestination {
  return { kind: "extra", page: companyPageId(rowId), companyUid };
}

/** Project detail tab the company Projects page can open on. */
export type CompanyProjectsTab = "tasks" | "files";

/**
 * The company's own Projects page (the sidepane Projects row), optionally
 * opened on one project. Atlas uses this so Open board stays in the company
 * pane instead of leaving for the cross-company Projects view, which closed
 * the company pane and showed Home's chat list.
 */
export function companyProjectsDestination(
  companyUid: string,
  project?: string | null,
  tab?: CompanyProjectsTab | null,
): NavigationDestination {
  const destination = companyRowDestination("projects", companyUid);
  const id = project?.trim();
  if (!id || destination.kind !== "extra") return destination;
  const params = new URLSearchParams({ project: id });
  if (tab) params.set("tab", tab);
  return { ...destination, param: params.toString() };
}

/** The project (and tab) a company Projects page param asks to open. */
export function companyProjectsFocus(
  param: string | null | undefined,
): { project: string; tab: CompanyProjectsTab | null } | null {
  const raw = param?.trim() ?? "";
  if (!raw) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  const project = params.get("project")?.trim();
  if (!project) return null;
  const tab = params.get("tab");
  return { project, tab: tab === "tasks" || tab === "files" ? tab : null };
}

/** Cached summary fields the pane shows as row counts. */
export interface CompanyPaneSummary {
  board: number;
  activity: { last7d: number };
  deployments: number;
  secrets: number;
}

export function companyPaneCounts(
  summary: CompanyPaneSummary | null | undefined,
): Record<string, number> {
  if (!summary) return {};
  // A partial summary (older server, empty body) must not crash the pane;
  // missing counts read as zero.
  return {
    projects: summary.board ?? 0,
    activity: summary.activity?.last7d ?? 0,
    deployments: summary.deployments ?? 0,
    secrets: summary.secrets ?? 0,
  };
}

/**
 * Company model with counts filled in. Atlas carries the live count so the
 * header chip and the Atlas row agree.
 *
 * `pageCounts` are the totals each company page published for its own list
 * (QA-014). They win over the cached summary, so a row always shows the same
 * number its page does; the summary only fills rows whose page has not loaded.
 */
export function companyPaneModel(
  company: SidepaneCompany,
  summary: CompanyPaneSummary | null | undefined,
  selectedId: string | null,
  pageCounts: Readonly<Record<string, number>> = {},
  /** OWNER-R24: false hides Grants and Billing (owners and admins only). */
  canManage = false,
): SidepaneListModel {
  const model = companySidepaneModel(company, selectedId);
  if (!canManage) {
    for (const section of model.sections) section.rows = section.rows.filter((row) => !MANAGER_ONLY_ROWS.has(row.id));
  }
  const counts = { ...companyPaneCounts(summary), ...pageCounts };
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (row.id === "atlas") row.live = model.liveCount > 0;
      const n = counts[row.id];
      if (n && n > 0) row.count = n;
      if (row.id === "projects" && row.count) {
        // The page counts PRDs on this computer; before it loads the pane
        // falls back to the shared board. Name whichever scope is showing.
        row.countScope = "projects" in pageCounts
          ? `${row.count} on this computer`
          : `${row.count} on the company board`;
      }
      else if (row.id === "atlas" && model.liveCount > 0) row.count = model.liveCount;
    }
  }
  return model;
}
