/**
 * Channel conversation header extras (console-rail US-015, scene home-channel).
 *
 * The 52 px header shows the name, "Company · N members", a pinned-note pill,
 * a live chip, and the members and details buttons. These helpers derive the
 * extras from data the shell already caches (directory row, channel status,
 * presence store); none of them fetch.
 */

import type { ChannelStatusModel } from "./channel-status-model.js";

/** "7 members" / "1 member"; null when the count is unknown. */
export function memberCountLabel(count: number | null | undefined): string | null {
  if (!count || count <= 0 || !Number.isFinite(count)) return null;
  return `${count} ${count === 1 ? "member" : "members"}`;
}

/**
 * Pinned note pill text: the first non-empty line of the channel's pinned
 * description, collapsed to one line. Null hides the pill.
 */
export function pinnedNoteText(description: string | null | undefined): string | null {
  if (!description) return null;
  const line = description
    .split(/\r?\n/)
    .map((part) => part.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  if (!line) return null;
  return line.replace(/\s+/g, " ");
}

/**
 * People and agents online in the channel right now, from the presence-backed
 * status model. Zero hides the live chip.
 */
export function liveMemberCount(status: ChannelStatusModel | null | undefined): number {
  if (!status) return 0;
  const seen = new Set<string>();
  for (const row of [...status.members, ...status.agents]) {
    if (row.online) seen.add(row.personUid);
  }
  return seen.size;
}
