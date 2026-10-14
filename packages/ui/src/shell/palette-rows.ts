/**
 * ⌘K command-palette row derivation.
 *
 * Two jobs, both pure so they can be unit-tested without a DOM:
 *
 * 1. `mergePaletteRows` — the palette used to index ONLY the host's cached
 *    `searchRows` (the persisted rail cache), while the sidebar rendered from
 *    its own live `channels` state. The two lists could disagree, so a channel
 *    was reachable in the rail but not in ⌘K (or the reverse). Merging the live
 *    rail rows with the cached rows by row id means a conversation can never be
 *    in one surface and missing from the other.
 *
 * 2. `paletteConversationItems` — human labels. Every row renders a
 *    HUMAN-READABLE primary label (channel display name with `#`, person or
 *    agent display name, project title) and a CONTEXT secondary line (company
 *    name, email, "bot", "project channel"). A raw identifier is never a
 *    label or a detail on its own: when nothing resolved we fall back to a
 *    PREFIXED id (`Bot · agt_…`) so the row is at least legible about what it
 *    is. Raw ids still live on `keywords`, which the palette matches against,
 *    so typing either a name or an id finds the row.
 */

import { isAgentUid } from "../chat/agent-channel.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { companyProjectsDestination } from "./company-pane.js";
import type { NavigationDestination } from "./navigation-history.js";
import {
  isStrictlyRicherConversationRow,
  resolveRailCompanyName,
  type ScopeCompany,
} from "../chat/sidebar-model.js";

/** A project id → human title hint (same shape `channelDisplayName` accepts). */
export interface PaletteProjectTitle {
  id: string;
  title?: string | null;
  name?: string | null;
}

export interface PaletteRowContext {
  /** Memberships used to turn a `cmp_…` uid into a company NAME. */
  companies?: ScopeCompany[];
  /** Project titles so a provisioned "Project slug hash" row reads as a name. */
  projectTitles?: PaletteProjectTitle[];
}

export interface PaletteConversationItem {
  /** Palette item id — the `conversation-` prefix drives its section. */
  id: string;
  /** The underlying `ConversationRow.id`. */
  rowId: string;
  /** Human primary label. Never a bare identifier. */
  label: string;
  /** Human secondary context. Never a bare identifier. */
  detail: string;
  /** Raw identifiers, space-joined, for id-based matching (not displayed). */
  keywords: string;
  lastActivityAt: number;
  /**
   * Presigned company icon for the row's owning company, or null. Company
   * channels resolve it; every other row kind stays null so the palette does
   * not imply a company mark for a DM or a personal channel.
   */
  iconUrl: string | null;
  row: ConversationRow;
  section: PaletteSectionId;
  companyUid: string | null;
  personal: boolean;
}

/** Longest id shown in a fallback label before it is elided. */
const ID_PREVIEW_LENGTH = 10;

/** `chn_01KWGKH0H5C8D8YC7XWZTQPTX6` → `chn_01KWGK…`. */
function elideId(value: string): string {
  const text = value.trim();
  if (text.length <= ID_PREVIEW_LENGTH) return text;
  return `${text.slice(0, ID_PREVIEW_LENGTH)}…`;
}

/** True when a candidate label is really just an opaque identifier. */
export function looksLikeRawId(value: string | null | undefined): boolean {
  const text = (value ?? "").trim();
  if (!text) return false;
  // `chn_…`, `prs_…`, `agt_…`, `cmp_…`, `proj_…` and friends: a short lowercase
  // prefix, an underscore, then an opaque token with no spaces.
  return /^[a-z]{2,6}_[A-Za-z0-9_-]{6,}$/.test(text);
}

/**
 * Merge the live rail rows with the host's cached rows so both the sidebar and
 * the palette index the same set. Union by `ConversationRow.id`; when both
 * sides carry a row, the strictly richer one wins (the live row normally has
 * membership, unread and roster the cache lacks), and ties keep the live row.
 */
export function mergePaletteRows(
  live: readonly ConversationRow[] = [],
  cached: readonly ConversationRow[] = [],
): ConversationRow[] {
  const byId = new Map<string, ConversationRow>();
  const order: string[] = [];
  const add = (row: ConversationRow): void => {
    if (!row?.id) return;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      order.push(row.id);
      return;
    }
    // Keep whichever row carries more resolved fields; `prev` wins ties so the
    // live list (added first) stays authoritative.
    if (isStrictlyRicherConversationRow(row, prev)) byId.set(row.id, row);
  };
  for (const row of live) add(row);
  for (const row of cached) add(row);
  return order.map((id) => byId.get(id) as ConversationRow);
}

function companyName(
  row: ConversationRow,
  context: PaletteRowContext,
): string | null {
  return resolveRailCompanyName(row.companyUid, context.companies ?? []);
}

/**
 * The company icon to show beside a palette row: the row's own icon first
 * (server-stamped), then the company roster. Company-scoped channels only.
 */
export function paletteRowIconUrl(
  row: ConversationRow,
  context: PaletteRowContext = {},
): string | null {
  if (row.kind !== "channel") return null;
  if ((row.channelScope ?? "").trim() !== "company") return null;
  if (row.iconUrl) return row.iconUrl;
  const uid = (row.companyUid ?? "").trim();
  if (!uid) return null;
  const hit = (context.companies ?? []).find((c) => c.companyUid === uid);
  return hit?.iconUrl ?? null;
}

function projectTitle(
  row: ConversationRow,
  context: PaletteRowContext,
): string | null {
  const pid = (row.projectId ?? "").trim();
  if (!pid) return null;
  const hit = (context.projectTitles ?? []).find((p) => p.id === pid);
  const titled = hit?.title?.trim() || hit?.name?.trim();
  return titled || null;
}

/** True when the row is a project-bound channel. */
function isProjectChannel(row: ConversationRow): boolean {
  if (row.kind !== "channel") return false;
  return row.channelScope === "project" || !!(row.projectId ?? "").trim();
}

/** True when the channel's roster is an HQ fleet agent. */
function isAgentChannel(row: ConversationRow): boolean {
  if (row.kind !== "channel") return false;
  return !!row.members?.some((m) => isAgentUid(m.personUid));
}

function isAgentDm(row: ConversationRow): boolean {
  return row.kind === "dm" && isAgentUid(row.personUid ?? "");
}

/**
 * Human primary label for one palette row.
 *
 * Channels read as `#name` (project channels prefer the project title), people
 * and agents as their display name, group DMs as their participants. When
 * nothing human resolved, the id is PREFIXED with what it is
 * (`Channel · chn_01KWGK…`) rather than rendered bare.
 */
export function paletteRowLabel(
  row: ConversationRow,
  context: PaletteRowContext = {},
): string {
  const rawTitle = (row.title ?? "").trim();
  const named = rawTitle && !looksLikeRawId(rawTitle) ? rawTitle : "";

  if (row.kind === "channel") {
    const title = projectTitle(row, context) || named;
    if (!title) {
      const id = (row.channelId ?? "").trim();
      return id ? `Channel · ${elideId(id)}` : "Channel";
    }
    // One `#`, never `##` — server names sometimes already carry it.
    return `#${title.replace(/^#+\s*/, "")}`;
  }

  if (row.kind === "group") {
    if (named) return named;
    const count = row.memberCount ?? row.members?.length ?? 0;
    if (count > 0) return `Group · ${count} members`;
    const id = (row.channelId ?? "").trim();
    return id ? `Group · ${elideId(id)}` : "Group";
  }

  // DM — a person or an agent.
  if (named) return named;
  const email = (row.email ?? "").trim();
  if (email) return email;
  const uid = (row.personUid ?? "").trim();
  if (!uid) return isAgentDm(row) ? "Bot" : "Person";
  return `${isAgentDm(row) ? "Bot" : "Person"} · ${elideId(uid)}`;
}

/**
 * Human secondary context for one palette row: company name plus what kind of
 * thing it is. Never an identifier — an unresolved company is simply omitted
 * rather than degraded to `cmp_…`.
 */
export function paletteRowDetail(
  row: ConversationRow,
  context: PaletteRowContext = {},
): string {
  const company = companyName(row, context);

  if (row.kind === "channel") {
    let kind = "channel";
    if (isAgentChannel(row)) kind = "bot channel";
    else if (isProjectChannel(row)) kind = "project channel";
    else if (row.channelScope === "company") kind = "company channel";
    else if (row.channelScope === "personal") kind = "personal channel";
    return company ? `${company} · ${kind}` : kind;
  }

  if (row.kind === "group") {
    const count = row.memberCount ?? row.members?.length ?? 0;
    const kind = count > 0 ? `group · ${count} members` : "group";
    return company ? `${company} · ${kind}` : kind;
  }

  // DM: an email is the most useful disambiguator; agents have none.
  const email = (row.email ?? "").trim();
  const kind = isAgentDm(row) ? "bot" : "person";
  const parts = [company, email || null, kind].filter(
    (part): part is string => !!part,
  );
  return parts.join(" · ");
}

/**
 * Raw identifiers for one row, space-joined. The palette matches the query
 * against label + detail + keywords, so pasting a `chn_…` / `prs_…` /
 * `agt_…` / `cmp_…` id (or a project slug) finds the row even though none of
 * those ids are rendered.
 */
export function paletteRowKeywords(row: ConversationRow): string {
  const parts = [
    row.id,
    row.channelId,
    row.personUid,
    row.companyUid,
    row.projectId,
    row.email,
    ...(row.members ?? []).map((m) => m.personUid),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const text = (part ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join(" ");
}

/**
 * Scope chips on ⌘K. Order is the Tab cycle: the active company, then every
 * company, then personal, then vault files only. "Tab widens scope" walks
 * this list forward.
 */
export const PALETTE_SCOPE_IDS = [
  "company",
  "all",
  "personal",
  "vault",
] as const;

export type PaletteScopeId = (typeof PALETTE_SCOPE_IDS)[number];

export type PaletteSectionId =
  | "projects"
  | "people"
  | "channels"
  | "files"
  | "skills"
  | "commands"
  | "create"
  | "also";

const SECTION_LABEL: Record<PaletteSectionId, string> = {
  projects: "Projects",
  people: "People and bots",
  channels: "Channels",
  files: "Files",
  skills: "Skills",
  commands: "Commands",
  create: "Create as new…",
  also: "Also try",
};

export function paletteSectionLabel(id: PaletteSectionId): string {
  return SECTION_LABEL[id];
}

/** Chip text. The company chip uses the active company's name. */
export function paletteScopeLabel(
  id: PaletteScopeId,
  companyName: string,
): string {
  if (id === "company") {
    const name = companyName.trim();
    return name || "Company";
  }
  if (id === "all") return "All companies";
  if (id === "personal") return "Personal";
  return "Vault only";
}

export function nextPaletteScope(
  id: PaletteScopeId,
  direction: 1 | -1 = 1,
): PaletteScopeId {
  const index = PALETTE_SCOPE_IDS.indexOf(id);
  const count = PALETTE_SCOPE_IDS.length;
  const next = (index + direction + count) % count;
  return PALETTE_SCOPE_IDS[next];
}

/** Which result group a conversation belongs to. */
export function conversationPaletteSection(
  row: ConversationRow,
): PaletteSectionId {
  if (row.kind === "dm" || row.kind === "group") return "people";
  if (isProjectChannel(row) && !(row.channelId ?? "").trim()) return "projects";
  if (row.kind === "channel" && isAgentChannel(row) && row.channelScope === "dm") {
    return "people";
  }
  return "channels";
}

export interface PaletteScopeFields {
  section: PaletteSectionId;
  /** Owning company, when the row is company-scoped. */
  companyUid?: string | null;
  /** Personal vault / personal channel / a DM with no company. */
  personal?: boolean;
}

/**
 * Whether a cached row is visible in the selected scope. Commands stay in
 * every scope except Vault only (files). Unscoped rows stay in the company
 * chip so navigation is never empty before a company is chosen.
 */
export function itemInPaletteScope(
  item: PaletteScopeFields,
  scope: PaletteScopeId,
  activeCompanyUid: string | null,
): boolean {
  if (scope === "all") return item.section !== "create" && item.section !== "also";
  if (scope === "vault") return item.section === "files";
  if (scope === "personal") {
    return item.personal === true || (!item.companyUid && item.section !== "commands");
  }
  if (item.section === "commands") return true;
  if (item.personal) return false;
  const uid = (activeCompanyUid ?? "").trim();
  if (!uid) return true;
  const rowUid = (item.companyUid ?? "").trim();
  if (!rowUid) return true;
  return rowUid === uid;
}

export interface CreateAsNewSpec {
  id: string;
  section: "create" | "also";
  label: string;
  detail: string;
  kind: "project" | "channel" | "note" | "ask" | "search-all";
}

function slugify(query: string): string {
  const slug = query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/**
 * Rows shown when a typed query matches nothing in the current scope.
 * Cached indexes produced zero hits; these are local actions, not a fetch.
 */
export function createAsNewItems(
  query: string,
  scopeLabel: string,
  options: { askName?: string; includeSearchAll?: boolean } = {},
): CreateAsNewSpec[] {
  const text = query.trim();
  if (!text) return [];
  const slug = slugify(text);
  const ask = (options.askName ?? "").trim();
  const rows: CreateAsNewSpec[] = [
    {
      id: "create-project",
      section: "create",
      kind: "project",
      label: `Project “${text}”`,
      detail: `${scopeLabel} · blank, brainstorm, or PRD`,
    },
    {
      id: "create-channel",
      section: "create",
      kind: "channel",
      label: `Channel #${slug}`,
      detail: `${scopeLabel} · open to the team`,
    },
    {
      id: "create-note",
      section: "create",
      kind: "note",
      label: `Note ${slug}.md`,
      detail: "In the vault",
    },
  ];
  if (ask) {
    rows.push({
      id: "create-ask",
      section: "create",
      kind: "ask",
      label: `Ask ${ask} about “${text}”`,
      detail: "Direct message",
    });
  }
  if (options.includeSearchAll !== false && scopeLabel !== "All companies") {
    rows.push({
      id: "create-search-all",
      section: "also",
      kind: "search-all",
      label: "Search all companies",
      detail: `Look for “${text}” outside ${scopeLabel}`,
    });
  }
  return rows;
}

/** Build the palette's CONVERSATIONS items from conversation rows. */
export function paletteConversationItems(
  rows: readonly ConversationRow[],
  context: PaletteRowContext = {},
): PaletteConversationItem[] {
  return rows.map((row) => ({
    id: `conversation-${row.id}`,
    rowId: row.id,
    label: paletteRowLabel(row, context),
    detail: paletteRowDetail(row, context),
    iconUrl: paletteRowIconUrl(row, context),
    keywords: paletteRowKeywords(row),
    lastActivityAt: row.lastActivityAt,
    row,
    section: conversationPaletteSection(row),
    companyUid: (row.companyUid ?? "").trim() || null,
    personal:
      row.channelScope === "personal" ||
      (row.kind !== "channel" && !(row.companyUid ?? "").trim()),
  }));
}

/** Minimal project shape the palette indexes (same list the Projects page loads). */
export interface PaletteProjectSource {
  id: string;
  name?: string | null;
  title?: string | null;
  company: string;
  prdPath?: string | null;
}

/** Member company used to map a project's company slug to its uid and name. */
export interface PaletteProjectCompany {
  slug: string;
  companyUid?: string | null;
  label?: string | null;
  personal?: boolean;
}

export interface PaletteProjectItem {
  id: string;
  label: string;
  detail: string;
  keywords: string;
  section: "projects";
  companyUid: string | null;
  personal: boolean;
  companySlug: string;
  projectId: string;
}

/** Folder that holds the project's prd.json (`…/projects/<folder>/prd.json`). */
function projectFolderName(prdPath: string | null | undefined): string {
  const parts = (prdPath ?? "").split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1];
  return /\.json$/i.test(last) ? (parts[parts.length - 2] ?? "") : last;
}

/**
 * PROJECTS rows for the palette (QA-079). Indexes the projects the Projects
 * page lists, for member companies only, so a project is findable by display
 * name, id, or folder name. Scope filtering uses the owning company's uid.
 */
export function paletteProjectItems(
  projects: readonly PaletteProjectSource[],
  companies: readonly PaletteProjectCompany[],
): PaletteProjectItem[] {
  const bySlug = new Map(companies.map((c) => [c.slug.trim(), c]));
  const seen = new Set<string>();
  const items: PaletteProjectItem[] = [];
  for (const project of projects) {
    const slug = (project.company ?? "").trim();
    const projectId = (project.id ?? "").trim();
    const company = bySlug.get(slug);
    if (!company || !projectId) continue;
    const key = `${slug}:${projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name =
      (project.name ?? "").trim() || (project.title ?? "").trim() || projectId;
    const folder = projectFolderName(project.prdPath);
    const companyLabel = (company.label ?? "").trim() || slug;
    items.push({
      id: `project-${slug}-${projectId}`,
      label: name,
      detail: `${companyLabel} · project`,
      keywords: [projectId, folder, slug].filter(Boolean).join(" "),
      section: "projects",
      companyUid: (company.companyUid ?? "").trim() || null,
      personal: company.personal === true,
      companySlug: slug,
      projectId,
    });
  }
  return items;
}

/**
 * Where a palette project row goes. A company project opens on that
 * company's own Projects page (the sidepane Projects row), so the company
 * stays selected. The cross-company Projects view closed the company pane
 * and showed Home's chat list. Personal projects have no company pane and
 * keep the Projects view.
 */
export function paletteProjectDestination(
  item: Pick<PaletteProjectItem, "companyUid" | "personal" | "companySlug" | "projectId">,
): NavigationDestination {
  const key = item.companyUid?.trim() || item.companySlug.trim();
  if (item.personal || !key) {
    return { kind: "projects", company: item.companySlug, project: item.projectId };
  }
  return companyProjectsDestination(key, item.projectId);
}

/**
 * Where the palette's Projects command goes: the selected company's own
 * Projects page, or the cross-company Projects view from Home.
 */
export function paletteProjectsCommandDestination(
  companyUid: string | null | undefined,
): NavigationDestination {
  const key = companyUid?.trim();
  return key ? companyProjectsDestination(key) : { kind: "projects" };
}
