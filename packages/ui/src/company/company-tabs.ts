/**
 * Company tab vocabulary — extracted from the desktop-alt `route.ts` so the
 * company surface can be routed by any host shell. Only the company-scoped
 * pieces live here; global desktop routing stays host-owned.
 */

export type CompanyTab =
  | "overview"
  | "goals"
  | "projects"
  | "skills"
  | "workers"
  | "knowledge"
  | "team"
  | "deployments"
  | "secrets"
  | "settings";

/** Internal destinations of the company-scoped operations workspace (DESKTOP-010; US-020 removed Activity). */
export type CompanyOperationsTab = "deployments" | "secrets" | "settings";

export const DEFAULT_COMPANY_TAB: CompanyTab = "overview";
export const DEFAULT_COMPANY_OPERATIONS_TAB: CompanyOperationsTab =
  "deployments";

const COMPANY_TABS: readonly CompanyTab[] = [
  "overview",
  "goals",
  "projects",
  "skills",
  "workers",
  "knowledge",
  "team",
  "deployments",
  "secrets",
  "settings",
];

/**
 * Legacy company-tab ids that still appear in deep links / pending routes,
 * remapped so old bookmarks do not 404.
 */
const LEGACY_COMPANY_TAB_REDIRECT: Readonly<Record<string, CompanyTab>> = {
  accounts: "overview",
  tasks: "projects",
  library: "skills",
  // US-020: the Activity page is gone — its digest lives on Overview.
  activity: "overview",
  // "more" is a primary-nav alias for the first operational section.
  more: DEFAULT_COMPANY_OPERATIONS_TAB,
};

export function isCompanyTab(
  value: string | undefined | null,
): value is CompanyTab {
  return COMPANY_TABS.includes(value as CompanyTab);
}

/** Normalize a company tab string (including legacy ids) to a live CompanyTab. */
export function normalizeCompanyTab(
  value: string | undefined | null,
): CompanyTab | undefined {
  if (!value) return undefined;
  if (isCompanyTab(value)) return value;
  return LEGACY_COMPANY_TAB_REDIRECT[value];
}

/** True when the company tab is one of the operations destinations. */
export function isCompanyOperationsTab(
  tab: CompanyTab | undefined | null,
): tab is CompanyOperationsTab {
  return tab === "deployments" || tab === "secrets" || tab === "settings";
}

/**
 * Compact internal destinations of the company operations workspace
 * (DESKTOP-010). Rendered inside CompanyOperationsPanel.
 */
export const COMPANY_OPERATIONS_SECTIONS: ReadonlyArray<{
  id: CompanyOperationsTab;
  label: string;
  meta: string;
}> = [
  { id: "deployments", label: "Deployments", meta: "Artifacts and services" },
  { id: "secrets", label: "Secrets", meta: "Metadata only" },
  { id: "settings", label: "Settings", meta: "Console workflows" },
];
