/**
 * Switcher / compose row helpers for the sidebar SEARCH and CREATE modals.
 *
 * Product data comes from live conversation rows. The authored
 * SWITCHER_ROWS / COMPOSE_SUGGESTIONS lists below are retained only for
 * isolated visual-QA tests — ChatSidebar must not use them as a fallback.
 */
import { mentionTypeForUid } from "./mentions";
import type { ConversationKind, ConversationRow } from "./sidebar-model";

export type SwitcherKind = "channel" | "dm" | "group";

export interface SwitcherRow {
  /** Stable id; channel ids map onto the fixture conversation `ch:<id>`. */
  id: string;
  /** Display name (channels render with a leading `#`). */
  name: string;
  /** Owning company / workspace label, right-aligned + muted. */
  company: string;
  kind: SwitcherKind;
  /**
   * Muted disambiguator after the name (email, agent label, or group roster).
   * Absent on channel rows — `#name` is already unique.
   */
  secondary?: string;
}

/**
 * "Search or jump to…" channel switcher roster (?view=v2). Order matches the
 * prototype: pinned/active channels, then a DM, a group, more channels, and the
 * cross-workspace Sender Agency rows last.
 */
export const SWITCHER_ROWS: SwitcherRow[] = [
  { id: "hq-desktop", name: "hq-desktop", company: "Indigo", kind: "channel" },
  { id: "hq-sync", name: "hq-sync", company: "Indigo", kind: "channel" },
  {
    id: "agent-orchestrator",
    name: "agent-orchestrator",
    company: "Indigo",
    kind: "channel",
  },
  {
    id: "gtm-standup",
    name: "gtm-standup",
    company: "Indigo",
    kind: "channel",
  },
  { id: "person-bryan", name: "Bryan", company: "Indigo", kind: "dm" },
  {
    id: "group-sofia-marcus-priya",
    name: "Sofia, Marcus, Priya",
    company: "Indigo",
    kind: "group",
  },
  {
    id: "standup-brief",
    name: "standup-brief",
    company: "Indigo",
    kind: "channel",
  },
  {
    id: "customer-conversations",
    name: "customer-conversations",
    company: "Indigo",
    kind: "channel",
  },
  {
    id: "enterprise-pricing",
    name: "enterprise-pricing",
    company: "Indigo",
    kind: "channel",
  },
  {
    id: "creative-pipeline",
    name: "creative-pipeline",
    company: "Sender Agency",
    kind: "channel",
  },
  {
    id: "ramen-bae",
    name: "ramen-bae",
    company: "Sender Agency",
    kind: "channel",
  },
];

/**
 * "New message" compose suggestion roster (?view=v2) — the recipients offered
 * under the To field before the user types.
 */
export const COMPOSE_SUGGESTIONS: SwitcherRow[] = [
  { id: "hq-desktop", name: "hq-desktop", company: "Indigo", kind: "channel" },
  { id: "hq-sync", name: "hq-sync", company: "Indigo", kind: "channel" },
  {
    id: "agent-orchestrator",
    name: "agent-orchestrator",
    company: "Indigo",
    kind: "channel",
  },
  {
    id: "gtm-standup",
    name: "gtm-standup",
    company: "Indigo",
    kind: "channel",
  },
  { id: "person-bryan", name: "Bryan", company: "Indigo", kind: "dm" },
  {
    id: "standup-brief",
    name: "standup-brief",
    company: "Indigo",
    kind: "channel",
  },
];

/** Case-insensitive name filter shared by the switcher + compose typeaheads. */
export function filterSwitcher(
  rows: SwitcherRow[],
  query: string,
): SwitcherRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
}

/**
 * Channel name the compose query could create, or null when creation should
 * not be offered. Offered whenever the typed query (leading `#` stripped,
 * spaces collapsed to `-`) is non-empty and no existing channel row matches it
 * exactly — the "typed a channel that doesn't exist" case. An exact match means
 * the user should pick the existing channel instead.
 */
export function channelCreateCandidate(
  rows: SwitcherRow[],
  query: string,
): string | null {
  const name = query.trim().replace(/^#+/, "").trim().replace(/\s+/g, "-");
  if (!name) return null;
  const q = name.toLowerCase();
  const exists = rows.some(
    (r) =>
      r.kind === "channel" &&
      r.name.trim().replace(/^#+/, "").toLowerCase() === q,
  );
  return exists ? null : name;
}

/** Map live sidebar conversations into the switcher/compose roster. */
export function switcherRowsFromConversations(
  rows: readonly ConversationRow[],
  companyLabel: (uid: string | null | undefined) => string = () => "",
): SwitcherRow[] {
  return rows.map((row) => {
    const secondary = switcherSecondary(row);
    // An unnamed group's title IS its roster join (groupDmLabel), so the
    // secondary would echo the name verbatim — drop it rather than stutter.
    const useSecondary =
      secondary && secondary.trim() !== row.title.trim() ? secondary : undefined;
    return {
      id: row.channelId ?? row.personUid ?? row.id,
      name: row.title,
      company: companyLabel(row.companyUid),
      kind: switcherKindFromConversation(row.kind),
      ...(useSecondary ? { secondary: useSecondary } : {}),
    };
  });
}

function switcherSecondary(row: ConversationRow): string | undefined {
  if (row.kind === "dm") return dmSwitcherSecondary(row);
  if (row.kind === "group") return groupSwitcherSecondary(row);
  return undefined;
}

function dmSwitcherSecondary(row: ConversationRow): string | undefined {
  const email = row.email?.trim();
  if (email) return email;
  const uid = (row.personUid ?? "").trim();
  if (!uid) return undefined;
  // mentions.ts: agt_ / agent:. Also accept agent_ as an agent-id prefix.
  if (
    mentionTypeForUid(uid) === "agent" ||
    uid.toLowerCase().startsWith("agent_")
  ) {
    return "Agent";
  }
  return undefined;
}

/** Mirrors groupDmLabel, but stays undefined when there is nothing to show. */
function groupSwitcherSecondary(row: ConversationRow): string | undefined {
  const names = (row.members ?? [])
    .map((member) => member.displayName?.trim())
    .filter((name): name is string => !!name);
  if (names.length > 0) {
    const shown = names.slice(0, 3);
    const extra = names.length - shown.length;
    return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
  }
  const n = row.memberCount ?? 0;
  return n > 0 ? `Group · ${n}` : undefined;
}

function switcherKindFromConversation(kind: ConversationKind): SwitcherKind {
  if (kind === "dm") return "dm";
  if (kind === "group") return "group";
  return "channel";
}

/** Two-letter avatar initials for dm/group rows. */
export function switcherInitials(name: string): string {
  const parts = name.replace(/[,]/g, "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
