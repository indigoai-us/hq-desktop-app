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
  goals: { story: "US-026", summary: "The company's goals and progress." },
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
  "company-settings": { story: "US-030", summary: "Company name, members, and billing." },
};

const ROW_LABELS: ReadonlyMap<string, string> = new Map(
  [...COMPANY_SIDEPANE_SECTIONS.flatMap((s) => s.rows), COMPANY_SETTINGS_ROW].map(
    (r) => [r.id, r.label],
  ),
);

/** Every row id the company pane routes, footer included. */
export const COMPANY_PANE_ROW_IDS: readonly string[] = [...ROW_LABELS.keys()];

export function companyPageId(rowId: string): string {
  return `${COMPANY_PAGE_PREFIX}${rowId}`;
}

/** Row id for a company page id, or null when the page is not one. */
export function companyRowForPage(page: string | null | undefined): string | null {
  if (!page || !page.startsWith(COMPANY_PAGE_PREFIX)) return null;
  const id = page.slice(COMPANY_PAGE_PREFIX.length);
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
 */
export function companyPaneModel(
  company: SidepaneCompany,
  summary: CompanyPaneSummary | null | undefined,
  selectedId: string | null,
): SidepaneListModel {
  const model = companySidepaneModel(company, selectedId);
  const counts = companyPaneCounts(summary);
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (row.id === "atlas") row.live = model.liveCount > 0;
      const n = counts[row.id];
      if (n && n > 0) row.count = n;
      else if (row.id === "atlas" && model.liveCount > 0) row.count = model.liveCount;
    }
  }
  return model;
}
