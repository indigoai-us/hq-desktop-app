/**
 * Shared people picker model (US-017).
 *
 * People, Groups, Agents, and Guests. Later stories (meetings, share, grants)
 * reuse this list; the view paints from whatever directory is already cached.
 */

import { isAgentUid } from "./agent-thinking.js";
import { channelSlug } from "./create-flow.js";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ConversationRow, DmContactInput } from "./sidebar-model.js";
import { registerAccountCache } from "../common/account-caches.js";

export type PeoplePickerKind = "person" | "group" | "agent" | "guest";

export interface PeoplePickerEntry {
  id: string;
  kind: PeoplePickerKind;
  name: string;
  detail: string;
  meta: string;
  live: boolean;
  companyUid: string | null;
  /** Every company this person or bot is known in (dedup merges these). */
  companyUids?: readonly string[];
  /** True when no source supplied a name or email; the label is a fallback. */
  unnamed?: boolean;
}

export interface PeoplePickerSection {
  kind: PeoplePickerKind;
  label: string;
  rows: PeoplePickerEntry[];
}

const SECTION_ORDER: { kind: PeoplePickerKind; label: string }[] = [
  { kind: "person", label: "People" },
  { kind: "group", label: "Groups" },
  { kind: "agent", label: "Bots" },
  { kind: "guest", label: "Guests" },
];

export function filterPickerEntries(
  entries: readonly PeoplePickerEntry[],
  query: string,
  companyUid?: string | null,
): PeoplePickerEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (companyUid && !entryInCompany(entry, companyUid)) return false;
    if (!needle) return true;
    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.detail.toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle)
    );
  });
}

/**
 * A company channel can only add people and bots known in that company.
 * People/bots with no company (personal DMs) are not eligible. Groups and
 * guests are passed in explicitly by the caller, so an unscoped one stays.
 */
function entryInCompany(entry: PeoplePickerEntry, companyUid: string): boolean {
  const known = entry.companyUids ?? (entry.companyUid ? [entry.companyUid] : []);
  if (known.length === 0) return entry.kind === "group" || entry.kind === "guest";
  return known.includes(companyUid);
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

/** Internal entity ids (person, agent, company) that must never be a row's primary label (QA-083). */
const RAW_ENTITY_ID = /^(prs|agt|cmp)_/i;

export function isRawEntityId(value: string | null | undefined): boolean {
  return RAW_ENTITY_ID.test((value ?? "").trim());
}

export const UNNAMED_MEMBER_LABEL = "Unnamed member";
export const PENDING_INVITE_LABEL = "Invited · pending";

/**
 * Primary label for a list row: name, else email, else a plain fallback.
 * Every picker row renders through this, so a bare prs_/agt_/cmp_ id can
 * never be the primary text. The id belongs in the secondary line only.
 */
export function rowPrimaryLabel(args: {
  name?: string | null;
  email?: string | null;
  pending?: boolean;
  fallback?: string;
}): string {
  const name = args.name?.trim() ?? "";
  if (name && !isRawEntityId(name)) return name;
  const email = args.email?.trim() ?? "";
  if (email && !isRawEntityId(email)) return email;
  if (args.pending) return PENDING_INVITE_LABEL;
  return args.fallback ?? UNNAMED_MEMBER_LABEL;
}

/** Roster rows from hq-pro may name the person `name` and flag invites by status. */
function contactName(contact: DmContactInput): string {
  const loose = contact as DmContactInput & { name?: unknown };
  const name = contact.displayName?.trim() || (typeof loose.name === "string" ? loose.name.trim() : "");
  return isRawEntityId(name) ? "" : name;
}

function contactPending(contact: DmContactInput): boolean {
  const loose = contact as DmContactInput & { status?: unknown; pending?: unknown };
  if (loose.pending === true) return true;
  const status = typeof loose.status === "string" ? loose.status.toLowerCase() : "";
  return status === "pending" || status === "invited";
}

/** Directory + contacts already in memory. Groups and guests are explicit. */
export function entriesFromDirectory(args: {
  rows: readonly ConversationRow[];
  contacts: readonly DmContactInput[];
  groups?: readonly PeoplePickerEntry[];
  guests?: readonly PeoplePickerEntry[];
  /** Company roster rows (see `loadPickerRoster`), already stamped with the company. */
  roster?: readonly DmContactInput[];
}): PeoplePickerEntry[] {
  const byId = new Map<string, PeoplePickerEntry>();
  const remember = (entry: PeoplePickerEntry) => {
    if (!entry.id || !entry.name) return;
    const prior = byId.get(entry.id);
    // A later source (contacts after a roster row, or the reverse) may carry
    // the real name; replace a fallback label with it.
    if (prior?.unnamed && !entry.unnamed) {
      const uids = new Set([...(prior.companyUids ?? []), ...(entry.companyUid ? [entry.companyUid] : [])]);
      byId.set(entry.id, { ...entry, companyUids: [...uids] });
      return;
    }
    if (!prior) {
      byId.set(entry.id, {
        ...entry,
        companyUids: entry.companyUid ? [entry.companyUid] : [],
      });
      return;
    }
    const uid = entry.companyUid;
    if (uid && !prior.companyUids?.includes(uid)) {
      byId.set(entry.id, { ...prior, companyUids: [...(prior.companyUids ?? []), uid] });
    }
  };

  for (const row of args.rows) {
    const uid = row.personUid?.trim();
    if (row.kind !== "dm" || !uid) continue;
    const agent = isAgentUid(uid);
    const named = Boolean(row.title?.trim()) && !isRawEntityId(row.title);
    const email = row.email?.trim() ?? "";
    remember({
      id: uid,
      kind: agent ? "agent" : "person",
      name: rowPrimaryLabel({ name: named ? row.title : "", email }),
      detail: agent ? "Bot" : named || email ? email : uid,
      unnamed: !named && !email,
      meta: "",
      live: false,
      companyUid: row.companyUid,
    });
  }
  for (const contact of [...args.contacts, ...(args.roster ?? [])]) {
    const uid = contact.personUid?.trim();
    if (!uid) continue;
    const agent = isAgentUid(uid);
    const name = contactName(contact);
    const email = contact.email?.trim() ?? "";
    const unnamed = !name && !email;
    remember({
      id: uid,
      kind: agent ? "agent" : "person",
      name: rowPrimaryLabel({ name, email, pending: contactPending(contact) }),
      detail: agent ? "Bot" : unnamed ? uid : email,
      unnamed,
      meta: "",
      live: false,
      companyUid: contact.companyUid ?? null,
    });
  }
  for (const group of args.groups ?? []) remember({ ...group, kind: "group" });
  for (const guest of args.guests ?? []) remember({ ...guest, kind: "guest" });
  return [...byId.values()];
}

/**
 * The `companies/<x>/` folder segment for a company record: its configured
 * slug, never one derived from the display name (QA-101). No company → personal.
 */
export function companyFolderSlug(company: { slug?: string | null } | null | undefined): string {
  return company?.slug?.trim() || "personal";
}

/** `companies/<slug>/channels/<name>` shown under the channel name field. */
export function channelPathPreview(companySlug: string, name: string): string {
  const company = companySlug.trim() || "personal";
  const slug = channelSlug(name);
  return slug ? `companies/${company}/channels/${slug}` : `companies/${company}/channels/`;
}

/**
 * Company rosters for the picker, keyed by company uid (QA-054). DM rows and
 * contacts only cover people the caller has talked to, so a company channel
 * picker built from them alone showed "No matches" for most of the company.
 */
const rosterCache = new Map<string, DmContactInput[]>();
registerAccountCache(() => rosterCache.clear());

/** Cached roster for a company, or an empty list before the first read. */
export function readPickerRoster(companyUid: string): DmContactInput[] {
  return rosterCache.get(companyUid) ?? [];
}

/**
 * Read the company roster from the same contacts route the Team page reads
 * (`GET /v1/notify/contacts?companyUid=…`). Rows are stamped with the company
 * uid so the company filter keeps them. The cache is updated on success; a
 * failed read is logged and leaves the cached roster in place.
 */
export async function loadPickerRoster(
  api: Pick<ChatSidebarApi, "listCompanyMembers" | "listContacts">,
  companyUid: string,
): Promise<DmContactInput[]> {
  if (!companyUid) return [];
  try {
    const res = api.listCompanyMembers
      ? await api.listCompanyMembers(companyUid)
      : await api.listContacts({ companyUid });
    const rows = Array.isArray(res?.contacts) ? res.contacts : [];
    const roster = rows
      .filter((row) => typeof row?.personUid === "string" && row.personUid.trim())
      .map((row) => ({ ...row, companyUid }));
    rosterCache.set(companyUid, roster);
    return roster;
  } catch (err) {
    console.error("people-picker: company roster read failed", err);
    return readPickerRoster(companyUid);
  }
}
