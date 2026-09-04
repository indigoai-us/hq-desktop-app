/**
 * Display-safe conversation titles for the desktop shell.
 *
 * Deep-link / widget DM opens often arrive with only a participant uid. The
 * rail later hydrates a human title; until then the header and composer must
 * never paint the raw uid.
 */

import type { ConversationRow } from "./sidebar-model.js";

export const DIRECT_MESSAGE_PLACEHOLDER = "Direct message";
export const GROUP_MESSAGE_PLACEHOLDER = "Group message";

const KNOWN_UID_PREFIXES = ["agt_", "usr_", "prs_", "person-", "email:"] as const;
/** Conservative: short lowercase type prefix + `_` + a ULID-shaped body (uppercase alnum, 10+ chars) — never a human name. */
const GENERIC_PARTICIPANT_UID = /^[a-z]{2,6}_[A-Z0-9]{10,}$/;

function trimOrEmpty(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

export function isRawParticipantUid(
  value: string | null | undefined,
): boolean {
  const next = trimOrEmpty(value);
  if (!next) return false;
  for (const prefix of KNOWN_UID_PREFIXES) {
    if (next.startsWith(prefix)) return true;
  }
  return GENERIC_PARTICIPANT_UID.test(next);
}

function matchingRailRow(
  row: ConversationRow,
  railRows: readonly ConversationRow[],
): ConversationRow | undefined {
  const byId = railRows.find((candidate) => candidate.id === row.id);
  if (byId) return byId;
  if (row.kind === "dm" && row.personUid) {
    return railRows.find(
      (candidate) =>
        candidate.personUid === row.personUid && !candidate.channelId,
    );
  }
  return undefined;
}

/** The matching rail row, or null when the directory has not hydrated it. */
export function resolveConversationRow(
  row: ConversationRow | null,
  railRows: readonly ConversationRow[],
): ConversationRow | null {
  if (!row) return null;
  return matchingRailRow(row, railRows) ?? null;
}

/**
 * Prefer a hydrated rail title. Never return a raw participant uid for a
 * DM/group; channels keep the stub title (often the channel id) unchanged.
 */
export function resolveConversationTitle(
  row: ConversationRow | null,
  railRows: readonly ConversationRow[],
): string {
  if (!row) return "";
  const railTitle = trimOrEmpty(resolveConversationRow(row, railRows)?.title);
  if (railTitle && !isRawParticipantUid(railTitle)) return railTitle;
  const own = trimOrEmpty(row.title);
  if (row.kind === "channel") return own || row.title;
  if (own && !isRawParticipantUid(own)) return own;
  if (row.kind === "dm") return DIRECT_MESSAGE_PLACEHOLDER;
  if (row.kind === "group") return GROUP_MESSAGE_PLACEHOLDER;
  return own;
}

export function composerPlaceholderFor(
  row: ConversationRow | null,
  title: string,
): string {
  if (!row) return "Reply…";
  if (row.kind === "dm" || row.kind === "group") {
    if (
      title === DIRECT_MESSAGE_PLACEHOLDER ||
      title === GROUP_MESSAGE_PLACEHOLDER
    ) {
      return "Send a message — or type @ to mention an agent…";
    }
    return `Message ${title} — or type @ to mention an agent…`;
  }
  return `Message # ${title} — or type @ to mention an agent…`;
}
