/**
 * Recipient items from what the chat sidebar already holds: DM rows,
 * contacts, the company roster, and channel rows. Names and dedupe come from
 * the people picker model so a raw prs_/agt_ id is never a row's name. Ids
 * follow ForwardCandidate (`dm:<uid>`, `ch:<channelId>`).
 */

import { entriesFromDirectory } from "../people-picker.js";
import type { ConversationRow, DmContactInput } from "../sidebar-model.js";
import type { RecipientItem } from "./recipient-picker-model.js";

function epoch(value: string | null | undefined): number {
  const at = value ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
}

export function recipientItemsFromDirectory(args: {
  rows: readonly ConversationRow[];
  contacts: readonly DmContactInput[];
  roster?: readonly DmContactInput[];
  /** Offer channels (New message opens one; Forward/Share post into one). */
  includeChannels?: boolean;
}): RecipientItem[] {
  const entries = entriesFromDirectory({ rows: args.rows, contacts: args.contacts, roster: args.roster });
  const recent = new Map<string, number>();
  const photo = new Map<string, string>();
  for (const row of args.rows) {
    if (row.kind === "dm" && row.personUid) {
      recent.set(row.personUid, Math.max(recent.get(row.personUid) ?? 0, row.lastActivityAt || 0));
    }
  }
  for (const contact of [...args.contacts, ...(args.roster ?? [])]) {
    const at = Math.max(epoch(contact.lastDmAt), epoch(contact.lastMessageAt));
    if (at > 0) recent.set(contact.personUid, Math.max(recent.get(contact.personUid) ?? 0, at));
    if (contact.avatarUrl) photo.set(contact.personUid, contact.avatarUrl);
  }

  const people: RecipientItem[] = entries
    .filter((entry) => entry.kind === "person" || entry.kind === "agent")
    .map((entry) => {
      const companyUids = entry.companyUids ?? (entry.companyUid ? [entry.companyUid] : []);
      // "Bot" was the old detail line; the type tag says that now.
      const subtitle = entry.kind === "agent" || entry.detail === entry.name ? "" : entry.detail;
      return {
        id: `dm:${entry.id}`,
        kind: entry.kind === "agent" ? "bot" : "person",
        name: entry.name,
        companyUid: companyUids[0] ?? null,
        companyUids,
        principalUid: entry.id,
        lastActivityAt: recent.get(entry.id) ?? 0,
        ...(subtitle ? { subtitle } : {}),
        avatarUrl: photo.get(entry.id) ?? null,
      };
    });

  if (!args.includeChannels) return people;
  const channels: RecipientItem[] = args.rows
    .filter((row) => row.kind !== "dm" && row.channelId && !row.browseOnly)
    .map((row) => ({
      id: `ch:${row.channelId}`,
      kind: row.kind === "group" ? "group" : "channel",
      name: row.title,
      companyUid: row.companyUid,
      companyUids: row.companyUid ? [row.companyUid] : [],
      channelId: row.channelId,
      lastActivityAt: row.lastActivityAt || 0,
      hint: row.memberCount ? `${row.memberCount} ${row.memberCount === 1 ? "member" : "members"}` : null,
    }));
  return [...people, ...channels];
}
