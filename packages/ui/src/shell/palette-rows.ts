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
 *    name, email, "agent", "project channel"). A raw identifier is never a
 *    label or a detail on its own: when nothing resolved we fall back to a
 *    PREFIXED id (`Agent · agt_…`) so the row is at least legible about what it
 *    is. Raw ids still live on `keywords`, which the palette matches against,
 *    so typing either a name or an id finds the row.
 */

import { isAgentUid } from "../chat/agent-channel.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
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
  row: ConversationRow;
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
  if (!uid) return isAgentDm(row) ? "Agent" : "Person";
  return `${isAgentDm(row) ? "Agent" : "Person"} · ${elideId(uid)}`;
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
    if (isAgentChannel(row)) kind = "agent channel";
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
  const kind = isAgentDm(row) ? "agent" : "person";
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
    keywords: paletteRowKeywords(row),
    lastActivityAt: row.lastActivityAt,
    row,
  }));
}
