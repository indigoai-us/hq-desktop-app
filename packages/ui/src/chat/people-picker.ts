/**
 * Shared people picker model (US-017).
 *
 * People, Groups, Agents, and Guests. Later stories (meetings, share, grants)
 * reuse this list; the view paints from whatever directory is already cached.
 */

import { isAgentUid } from "./agent-thinking.js";
import { channelSlug } from "./create-flow.js";
import type { ConversationRow, DmContactInput } from "./sidebar-model.js";

export type PeoplePickerKind = "person" | "group" | "agent" | "guest";

export interface PeoplePickerEntry {
  id: string;
  kind: PeoplePickerKind;
  name: string;
  detail: string;
  meta: string;
  live: boolean;
  companyUid: string | null;
}

export interface PeoplePickerSection {
  kind: PeoplePickerKind;
  label: string;
  rows: PeoplePickerEntry[];
}

const SECTION_ORDER: { kind: PeoplePickerKind; label: string }[] = [
  { kind: "person", label: "People" },
  { kind: "group", label: "Groups" },
  { kind: "agent", label: "Agents" },
  { kind: "guest", label: "Guests" },
];

export function filterPickerEntries(
  entries: readonly PeoplePickerEntry[],
  query: string,
  companyUid?: string | null,
): PeoplePickerEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (companyUid && entry.companyUid && entry.companyUid !== companyUid) return false;
    if (!needle) return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.detail.toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle)
    );
  });
}

export function groupPickerEntries(
  entries: readonly PeoplePickerEntry[],
): PeoplePickerSection[] {
  return SECTION_ORDER.map((section) => ({
    ...section,
    rows: entries.filter((entry) => entry.kind === section.kind),
  })).filter((section) => section.rows.length > 0);
}

export function togglePickerId(selected: readonly string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((value) => value !== id)
    : [...selected, id];
}

/** Directory + contacts already in memory. Groups and guests are explicit. */
export function entriesFromDirectory(args: {
  rows: readonly ConversationRow[];
  contacts: readonly DmContactInput[];
  groups?: readonly PeoplePickerEntry[];
  guests?: readonly PeoplePickerEntry[];
}): PeoplePickerEntry[] {
  const byId = new Map<string, PeoplePickerEntry>();
  const remember = (entry: PeoplePickerEntry) => {
    if (!entry.id || !entry.name) return;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  };

  for (const row of args.rows) {
    const uid = row.personUid?.trim();
    if (row.kind !== "dm" || !uid) continue;
    const agent = isAgentUid(uid);
    remember({
      id: uid,
      kind: agent ? "agent" : "person",
      name: row.title,
      detail: agent ? "Bot" : (row.email ?? ""),
      meta: "",
      live: false,
      companyUid: row.companyUid,
    });
  }
  for (const contact of args.contacts) {
    const uid = contact.personUid?.trim();
    if (!uid) continue;
    const agent = isAgentUid(uid);
    const name = contact.displayName?.trim() || contact.email?.trim() || uid;
    remember({
      id: uid,
      kind: agent ? "agent" : "person",
      name,
      detail: agent ? "Bot" : (contact.email?.trim() ?? ""),
      meta: "",
      live: false,
      companyUid: contact.companyUid ?? null,
    });
  }
  for (const group of args.groups ?? []) remember({ ...group, kind: "group" });
  for (const guest of args.guests ?? []) remember({ ...guest, kind: "guest" });
  return [...byId.values()];
}

/** `companies/<slug>/channels/<name>` shown under the channel name field. */
export function channelPathPreview(companyLabel: string, name: string): string {
  const company = channelSlug(companyLabel) || "personal";
  const slug = channelSlug(name);
  return slug ? `companies/${company}/channels/${slug}` : `companies/${company}/channels/`;
}
