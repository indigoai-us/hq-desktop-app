/**
 * Names for DM peers in the Messages sidebar.
 *
 * The DM thread index (dm-threads, pair unreads) carries bare person ids. The
 * global contacts roster does not list everyone you have a thread with: a
 * teammate in a company whose roster was not part of that read, or a pair
 * where only you have written (so the thread has no message from them to
 * take a name from). Those rows used to be titled by the raw `prs_…` id.
 *
 * This module collects names from every source the sidebar has (contacts,
 * thread messages, channel rosters, per-company member rosters) into one
 * directory keyed by uid, and produces a label that is never a raw id:
 * name, else email, else "Unknown person" ("Unknown bot" for an agt_ id),
 * matching the Projects cards (`common/people/people.ts`).
 */

import { isRawPersonId } from "../common/people/people.js";
import { isAgentUid } from "./agent-thinking";

export const UNKNOWN_PERSON_LABEL = "Unknown person";
export const UNKNOWN_BOT_LABEL = "Unknown bot";

const RAW_ID_PREFIX = /^(?:prs|agt|agent)_[A-Za-z0-9]/i;

export interface PeerNameEntry {
  displayName?: string | null;
  email?: string | null;
}

/** uid → best known name and email. */
export type PeerDirectory = ReadonlyMap<string, PeerNameEntry>;

/** A trimmed name that is safe to show, or null when blank or an id. */
export function readablePeerName(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (isRawPersonId(v) || RAW_ID_PREFIX.test(v)) return null;
  return v;
}

function readableEmail(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && v.includes("@") ? v : null;
}

/** The neutral label for a peer nothing names. */
export function unknownPeerLabel(uid: string | null | undefined): string {
  return uid && isAgentUid(uid) ? UNKNOWN_BOT_LABEL : UNKNOWN_PERSON_LABEL;
}

/** True when `title` is one of the neutral unknown labels. */
export function isUnknownPeerLabel(title: string | null | undefined): boolean {
  const t = title?.trim();
  return t === UNKNOWN_PERSON_LABEL || t === UNKNOWN_BOT_LABEL;
}

/**
 * Label for a DM peer: the readable name (own, then directory), else the
 * email (own, then directory), else the neutral unknown label. Never the uid.
 */
export function dmPeerLabel(
  peer: { personUid?: string | null } & PeerNameEntry,
  directory?: PeerDirectory | null,
): string {
  const uid = peer.personUid?.trim() ?? "";
  const known = uid ? directory?.get(uid) : undefined;
  return (
    readablePeerName(peer.displayName) ??
    readablePeerName(known?.displayName) ??
    readableEmail(peer.email) ??
    readableEmail(known?.email) ??
    unknownPeerLabel(uid)
  );
}

/** True when a contact carries neither a readable name nor an email. */
export function isUnnamedPeer(peer: PeerNameEntry): boolean {
  return !readablePeerName(peer.displayName) && !readableEmail(peer.email);
}

/** True when a contact has no readable name (an email alone still counts as unnamed). */
function lacksName(peer: PeerNameEntry): boolean {
  return !readablePeerName(peer.displayName);
}

/**
 * Add roster-shaped rows (contacts, company members, channel members) to a
 * directory. Earlier entries win per field; a later row only fills what is
 * still missing.
 */
export function addToPeerDirectory(
  directory: Map<string, PeerNameEntry>,
  rows: ReadonlyArray<
    | ({ personUid?: string | null } & PeerNameEntry)
    | null
    | undefined
  >,
): Map<string, PeerNameEntry> {
  for (const row of rows) {
    const uid = row?.personUid?.trim();
    if (!uid) continue;
    const name = readablePeerName(row?.displayName);
    const email = readableEmail(row?.email);
    if (!name && !email) continue;
    const prev = directory.get(uid);
    directory.set(uid, {
      displayName: readablePeerName(prev?.displayName) ?? name,
      email: readableEmail(prev?.email) ?? email,
    });
  }
  return directory;
}

/**
 * Fill each contact's missing (or raw-id) display name and missing email from
 * the directory. Contacts that gain nothing are returned unchanged, and the
 * input array is returned as-is when nothing changed.
 */
export function applyPeerDirectory<
  T extends { personUid: string } & PeerNameEntry,
>(contacts: readonly T[], directory: PeerDirectory | null | undefined): T[] {
  if (!directory || directory.size === 0) return contacts as T[];
  let changed = false;
  const out = contacts.map((contact) => {
    const known = directory.get(contact.personUid.trim());
    if (!known) return contact;
    const name = readablePeerName(contact.displayName)
      ? null
      : readablePeerName(known.displayName);
    const email = readableEmail(contact.email) ? null : readableEmail(known.email);
    if (!name && !email) return contact;
    changed = true;
    return {
      ...contact,
      ...(name ? { displayName: name } : {}),
      ...(email ? { email } : {}),
    };
  });
  return changed ? out : (contacts as T[]);
}

/** Uids among `contacts` that still have no readable name. */
export function peersMissingNames(
  contacts: ReadonlyArray<{ personUid: string } & PeerNameEntry>,
): string[] {
  const out: string[] = [];
  for (const contact of contacts) {
    const uid = contact.personUid.trim();
    if (uid && lacksName(contact)) out.push(uid);
  }
  return out;
}
