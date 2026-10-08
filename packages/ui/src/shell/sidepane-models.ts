/**
 * Sidepane content models (console-rail US-006).
 *
 * One Sidepane host renders every rail destination's left pane. The host owns
 * the shared grammar (header slot, scrolling body, pinned footer, 31 px rows,
 * 10 px mono section labels, background-highlight selection); this module owns
 * the three content models it swaps between and the per-destination scroll
 * memory that survives the swap.
 *
 *   - home:    the existing ChatSidebar (Messages & Inbox). The account footer
 *              lives on the rail avatar (US-010), not in this pane.
 *   - company: Console-aligned sections with Company settings pinned in the footer.
 *   - atlas:   the company sections with Atlas selected, then Live now / Idle rosters.
 *
 * Pure data and arithmetic only, so it stays out of the boot path's cost.
 */

/** Row height in px. Matches the Messages sidebar row (7 + 17 + 7). */
export const SIDEPANE_ROW_HEIGHT = 31;

/** Section label height in px (10 px mono label with 12 / 4 px padding). */
export const SIDEPANE_SECTION_HEIGHT = 30;

/** Lists longer than this window their rows instead of rendering all of them. */
export const SIDEPANE_VIRTUALIZE_THRESHOLD = 200;

/** Extra rows rendered above and below the viewport while windowing. */
export const SIDEPANE_OVERSCAN = 12;

export type SidepaneModelKind = "home" | "company" | "atlas";

/** Stable key for one destination's pane; scroll memory is keyed by it. */
export type SidepaneModelKey =
  | "home"
  | `company:${string}`
  | `atlas:${string}`;

export interface SidepaneSelectionState {
  tenantCompanyId: string | null;
  /** True when the company's Atlas landing page is the active destination. */
  atlasActive?: boolean;
}

export function sidepaneModelKey(state: SidepaneSelectionState): SidepaneModelKey {
  const company = state.tenantCompanyId?.trim();
  if (!company) return "home";
  return state.atlasActive ? `atlas:${company}` : `company:${company}`;
}

export function sidepaneModelKind(key: SidepaneModelKey): SidepaneModelKind {
  if (key === "home") return "home";
  return key.startsWith("atlas:") ? "atlas" : "company";
}

export type SidepaneMark = "circle" | "square";

export interface SidepaneRow {
  id: string;
  label: string;
  /** Optional identity mark: circle for a person, rounded square for a bot. */
  mark?: SidepaneMark;
  /** Live presence dot (green is reserved for live). */
  live?: boolean;
  /** Trailing count (unread or item count). */
  count?: number;
  /** Plain-language scope of the count, shown as its tooltip. */
  countScope?: string;
}

export interface SidepaneSection {
  id: string;
  /** Rendered as a 10 px mono uppercase label; omit for an unlabeled group. */
  label?: string;
  rows: SidepaneRow[];
}

export interface SidepaneListModel {
  kind: Exclude<SidepaneModelKind, "home">;
  key: SidepaneModelKey;
  title: string;
  /** Live count chip in the header. */
  liveCount: number;
  sections: SidepaneSection[];
  /** Row pinned in the footer; none since OWNER-R24 moved Company settings into the panel. */
  footerRow: SidepaneRow | null;
  selectedId: string | null;
}

/** Console company groups, in order (design.md, Sidepane › Company). */
export const COMPANY_SIDEPANE_SECTIONS: readonly SidepaneSection[] = [
  {
    id: "overview",
    rows: [
      { id: "atlas", label: "Atlas" },
      { id: "projects", label: "Projects" },
      { id: "activity", label: "Activity" },
    ],
  },
  {
    id: "people",
    label: "People",
    rows: [
      { id: "team", label: "Team" },
      { id: "bots", label: "Bots" },
      { id: "groups", label: "Groups" },
      { id: "grants", label: "Grants" },
    ],
  },
  {
    id: "brain",
    label: "Brain",
    rows: [
      { id: "knowledge", label: "Knowledge" },
      { id: "policies", label: "Policies" },
      { id: "skills", label: "Skills" },
      { id: "workers", label: "Workers" },
    ],
  },
  {
    id: "files",
    label: "Files and connect",
    rows: [
      { id: "vault", label: "Vault" },
      { id: "integrations", label: "Integrations" },
      { id: "secrets", label: "Secrets" },
      { id: "deployments", label: "Deployments" },
    ],
  },
  // OWNER-R24: company settings live in the panel; no separate settings page.
  {
    id: "settings",
    label: "Settings",
    rows: [
      { id: "general", label: "General" },
      { id: "brand", label: "Brand" },
      { id: "billing", label: "Billing" },
    ],
  },
];

/** OWNER-R24: rows only owners and admins can open; hidden from everyone else. */
export const MANAGER_ONLY_ROWS: ReadonlySet<string> = new Set(["grants", "billing"]);

export const COMPANY_SETTINGS_ROW: SidepaneRow = {
  id: "company-settings",
  label: "Company settings",
};

export interface SidepaneCompany {
  uid: string;
  label: string;
  liveCount?: number;
}

function cloneSections(): SidepaneSection[] {
  return COMPANY_SIDEPANE_SECTIONS.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r })) }));
}

export function companySidepaneModel(
  company: SidepaneCompany,
  selectedId: string | null = null,
): SidepaneListModel {
  return {
    kind: "company",
    key: `company:${company.uid}`,
    title: company.label || company.uid,
    liveCount: Math.max(0, company.liveCount ?? 0),
    sections: cloneSections(),
    footerRow: null,
    selectedId,
  };
}

export interface SidepaneRosterEntry {
  uid: string;
  name: string;
  kind: "human" | "bot";
  live: boolean;
}

/** Roster row for a company with no teammates yet; opens the Team page. */
export const INVITE_TEAMMATE_ROW: SidepaneRow = { id: "invite-teammate", label: "Invite a teammate" };

/**
 * Atlas keeps the company sections with Atlas selected. People and bots are
 * shown on the Atlas page itself, so the sidepane lists no roster; the roster
 * only drives the live count chip and the invite row.
 */
export function atlasSidepaneModel(
  company: SidepaneCompany,
  roster: readonly SidepaneRosterEntry[],
): SidepaneListModel {
  const sections = cloneSections();
  // US-014: a company with no teammates yet gets an invite row.
  if (roster.filter((p) => p.kind === "human").length <= 1) {
    sections.push({ id: "invite", rows: [{ ...INVITE_TEAMMATE_ROW }] });
  }
  return {
    kind: "atlas",
    key: `atlas:${company.uid}`,
    title: company.label || company.uid,
    liveCount: roster.filter((p) => p.live).length,
    sections,
    footerRow: null,
    selectedId: "atlas",
  };
}

/** Flattened list item: a section label or a row, each one fixed-height. */
export type SidepaneItem =
  | { type: "section"; key: string; label: string }
  | { type: "row"; key: string; row: SidepaneRow };

export function flattenSections(sections: readonly SidepaneSection[]): SidepaneItem[] {
  const out: SidepaneItem[] = [];
  for (const section of sections) {
    if (section.label) {
      out.push({ type: "section", key: `s:${section.id}`, label: section.label });
    }
    for (const row of section.rows) {
      out.push({ type: "row", key: `r:${section.id}:${row.id}`, row });
    }
  }
  return out;
}

export interface WindowRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/**
 * Visible slice for a fixed-height list. Below the threshold everything
 * renders; above it only the viewport plus overscan does, with spacer padding
 * keeping the scrollbar honest.
 */
export function windowRange(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = SIDEPANE_ROW_HEIGHT,
  overscan = SIDEPANE_OVERSCAN,
  threshold = SIDEPANE_VIRTUALIZE_THRESHOLD,
): WindowRange {
  if (count <= threshold) return { start: 0, end: count, padTop: 0, padBottom: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count, first - overscan));
  const end = Math.max(start, Math.min(count, first + visible + overscan));
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight,
  };
}

/** Per-destination scroll offsets; one instance lives with the host. */
export class SidepaneScrollMemory {
  private readonly offsets = new Map<string, number>();

  save(key: string, scrollTop: number): void {
    if (!Number.isFinite(scrollTop)) return;
    this.offsets.set(key, Math.max(0, scrollTop));
  }

  get(key: string): number {
    return this.offsets.get(key) ?? 0;
  }

  has(key: string): boolean {
    return this.offsets.has(key);
  }
}
