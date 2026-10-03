/**
 * OWNER-R5: one resolver for every value that names a person or a bot.
 *
 * Projects, Goals, Team and the other console-rail surfaces receive people as
 * a mix of keys: prs_ and agt_ ids, emails, handles ("corey", "jacob-posel")
 * and display names. Every key resolves through the company roster (people and
 * bots, the Team read) to one identity, so the same person under several keys
 * shows once, and a raw id is never shown.
 */

export type PersonKind = "human" | "agent";

/** One roster row: a member or bot from the Team read. */
export interface PeopleRosterEntry {
  id: string;
  kind?: PersonKind;
  displayName?: string | null;
  email?: string | null;
  /** Extra keys known to name this entry (secondary emails, handles). */
  aliases?: readonly string[];
}

export interface PersonIdentity {
  /** Stable key for this identity: the roster id, else the normalized value. */
  key: string;
  kind: PersonKind;
  /** Name shown in normal text. Never a raw id. */
  name: string;
  /** Email for a person, "Bot" for a bot; shown muted. Null when unknown. */
  detail: string | null;
  /** True when the value matched a roster entry. */
  resolved: boolean;
}

export interface PeopleIndex {
  byKey: Map<string, PersonIdentity>;
  /** Number of roster entries indexed. */
  size: number;
}

const RAW_ID = /^(prs|agt|agent|usr|user|cmp|chn|ent)_[a-z0-9]{6,}$/i;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A value that is an opaque id and must never reach the screen. */
export function isRawPersonId(value: string): boolean {
  const v = value.trim();
  return RAW_ID.test(v) || ULID.test(v);
}

/** Matches a raw id anywhere in text; used by the DOM guard. */
export const RAW_PERSON_ID_IN_TEXT = /\b(?:prs|agt)_[A-Za-z0-9]{6,}\b/;

function isEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

function slugOf(value: string): string {
  return norm(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Keys a roster entry answers to: id, email, email local part, name and its slug. */
function keysFor(entry: PeopleRosterEntry): { strong: string[]; weak: string[] } {
  const strong = [entry.id, entry.email ?? "", ...(entry.aliases ?? [])]
    .map((v) => norm(v))
    .filter(Boolean);
  const weak: string[] = [];
  const name = (entry.displayName ?? "").trim();
  if (name && !isRawPersonId(name) && !isEmail(name)) {
    weak.push(norm(name), slugOf(name));
    const first = slugOf(name.split(/\s+/)[0] ?? "");
    if (first) weak.push(first);
  }
  for (const email of [entry.email ?? "", ...(entry.aliases ?? [])]) {
    if (isEmail(email)) weak.push(norm(email.split("@")[0]!));
  }
  return { strong, weak };
}

function identityFor(entry: PeopleRosterEntry): PersonIdentity {
  const kind: PersonKind = entry.kind ?? (/^(agt|agent)_/i.test(entry.id) ? "agent" : "human");
  const rawName = (entry.displayName ?? "").trim();
  const email = (entry.email ?? "").trim() || null;
  const name =
    rawName && !isRawPersonId(rawName) && !isEmail(rawName)
      ? rawName
      : kind === "agent"
        ? "Unknown bot"
        : email ?? "Unknown person";
  const detail = kind === "agent" ? "Bot" : email && email !== name ? email : null;
  return { key: entry.id, kind, name, detail, resolved: true };
}

/**
 * Index the roster. Entries sharing an id or email merge into one identity.
 * Weak keys (handles, first names, email local parts) only map when they
 * point at exactly one identity, so two people called "Sam" stay apart.
 */
export function buildPeopleIndex(entries: readonly PeopleRosterEntry[]): PeopleIndex {
  const byKey = new Map<string, PersonIdentity>();
  const weakHits = new Map<string, Set<PersonIdentity>>();
  for (const entry of entries) {
    if (!entry || !entry.id) continue;
    const { strong, weak } = keysFor(entry);
    let identity = strong.map((k) => byKey.get(k)).find(Boolean) ?? null;
    if (!identity) identity = identityFor(entry);
    else if (!identity.detail && entry.email && identity.kind === "human") {
      identity.detail = entry.email.trim();
    }
    for (const k of strong) if (!byKey.has(k)) byKey.set(k, identity);
    for (const k of weak) {
      const set = weakHits.get(k) ?? new Set<PersonIdentity>();
      set.add(identity);
      weakHits.set(k, set);
    }
  }
  for (const [k, set] of weakHits) {
    if (set.size === 1 && !byKey.has(k)) byKey.set(k, [...set][0]!);
  }
  return { byKey, size: entries.length };
}

export const EMPTY_PEOPLE_INDEX: PeopleIndex = { byKey: new Map(), size: 0 };

const warned = new Set<string>();

/**
 * Resolve any person or bot value to one identity for display.
 * Unresolved: an email shows as itself; anything else shows "Unknown person"
 * (or "Unknown bot" for an agt_ id). While the roster loads, a neutral
 * placeholder stands in. A raw id is never returned as a name.
 */
export function resolvePerson(
  index: PeopleIndex,
  value: string | null | undefined,
  opts: { loading?: boolean } = {},
): PersonIdentity {
  const raw = (value ?? "").trim();
  const key = norm(raw);
  const hit = key ? (index.byKey.get(key) ?? index.byKey.get(slugOf(raw))) : undefined;
  if (hit) return hit;
  const agent = /^(agt|agent)_/i.test(raw);
  const kind: PersonKind = agent ? "agent" : "human";
  if (raw && isEmail(raw)) return { key, kind, name: raw, detail: null, resolved: false };
  if (opts.loading) return { key, kind, name: "…", detail: null, resolved: false };
  if (raw && !isRawPersonId(raw) && /\s/.test(raw)) {
    // A full display name with no roster match is still a name, not an id.
    return { key, kind, name: raw, detail: null, resolved: false };
  }
  if (raw && index.size === 0 && !isRawPersonId(raw) && !/^(agt|agent|prs)_/i.test(raw)) {
    // No roster for this surface (a personal board): a handle is shown as
    // written, since it is a name the person chose, not an id.
    return { key, kind, name: raw, detail: null, resolved: false };
  }
  if (raw && index.size > 0 && !warned.has(key)) {
    warned.add(key);
    console.warn("[people] unresolved person key", raw);
  }
  return { key: key || "unknown", kind, name: agent ? "Unknown bot" : "Unknown person", detail: agent ? "Bot" : null, resolved: false };
}

/** Plain-text label: "Name email" for search, titles and aria labels. */
export function personLabel(identity: PersonIdentity): string {
  return identity.detail ? `${identity.name} ${identity.detail}` : identity.name;
}

/**
 * Collapse a list of person values to one option per identity, people sorted
 * by name then bots, for filters and pickers.
 */
export function uniquePeople(
  index: PeopleIndex,
  values: Iterable<string | null | undefined>,
  opts: { loading?: boolean } = {},
): PersonIdentity[] {
  const out = new Map<string, PersonIdentity>();
  for (const value of values) {
    if (!value || !value.trim()) continue;
    const identity = resolvePerson(index, value, opts);
    if (!out.has(identity.key)) out.set(identity.key, identity);
  }
  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "human" ? -1 : 1,
  );
}

/** True when `value` names the identity with key `identityKey`. */
export function personMatches(
  index: PeopleIndex,
  value: string | null | undefined,
  identityKey: string,
  opts: { loading?: boolean } = {},
): boolean {
  if (!value) return false;
  return resolvePerson(index, value, opts).key === identityKey;
}

/** Roster rows (contacts or members wire shape) to index entries. */
export function rosterEntriesFromRows(rows: readonly unknown[]): PeopleRosterEntry[] {
  const out: PeopleRosterEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const id = s(rec.personUid) || s(rec.agentUid) || s(rec.uid) || s(rec.id);
    if (!id) continue;
    const kindRaw = s(rec.kind) || s(rec.entityType) || s(rec.type);
    const kind: PersonKind =
      kindRaw === "agent" || kindRaw === "bot" || rec.isAgent === true || /^(agt|agent)_/i.test(id) ? "agent" : "human";
    const aliases = [s(rec.handle), s(rec.slug), s(rec.username)].filter(Boolean);
    out.push({ id, kind, displayName: s(rec.displayName) || s(rec.name) || null, email: s(rec.email) || null, aliases });
  }
  return out;
}
