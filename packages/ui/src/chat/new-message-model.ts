import type { ConversationRow } from "./sidebar-model.js";

/**
 * The conversation New message would otherwise duplicate.
 *
 * One person: their direct message. Two or more: a group whose members are
 * exactly those people (the roster may or may not list you, so one extra
 * member is allowed). The iOS app shows this conversation and opens it
 * rather than starting a second one with the same people (hq-native-mobile
 * #44); the desktop used to create a new group every time.
 */
export function findExistingConversation(
  rows: readonly ConversationRow[],
  personUids: readonly string[],
): ConversationRow | null {
  const want = [...new Set(personUids.map((uid) => uid.trim()).filter(Boolean))];
  if (want.length === 0) return null;
  if (want.length === 1) {
    return rows.find((row) => row.kind === "dm" && row.personUid === want[0]) ?? null;
  }
  const wanted = new Set(want);
  const matches = rows.filter((row) => {
    if (row.kind !== "group" || !row.channelId) return false;
    const members = new Set((row.members ?? []).map((member) => member.personUid));
    if (![...wanted].every((uid) => members.has(uid))) return false;
    const extra = [...members].filter((uid) => !wanted.has(uid)).length;
    return extra <= 1;
  });
  // The most recently active, if more than one group fits.
  return matches.sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ?? null;
}
