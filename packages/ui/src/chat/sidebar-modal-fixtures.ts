/**
 * Switcher row helpers for the sidebar SEARCH and HISTORY overlays.
 *
 * Product data comes from live conversation rows; ChatSidebar does not
 * use static fixture fallbacks.
 *
 * The create flow's own rules live in `create-flow.ts`.
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


/** Case-insensitive name filter shared by the switcher + compose typeaheads. */
export function filterSwitcher(
  rows: SwitcherRow[],
  query: string,
): SwitcherRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q));
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
    return "Bot";
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
