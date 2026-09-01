/**
 * Structured channel mentions — same contract as hq-mobile / hq-pro.
 *
 * A mention is an entity (person prs_* or agent agt_*), not a work-mesh
 * thread. POST /v1/notify/channels/{id}/messages { mentions } adds a
 * non-member when the caller is the channel owner. Do not create a parallel
 * work-mesh thread for @-mentions.
 */

export type MentionParticipantType = "human" | "agent";

export interface MentionTarget {
  participantUid: string;
  participantType: MentionParticipantType;
  displayName: string;
  email?: string;
  /** Owning company for this roster row, when the payload carries one. */
  companyUid?: string;
  /** Human-readable company label (resolved by the shell from companyUid). */
  companyName?: string;
  /**
   * Display-only suffix set by {@link disambiguateMentionTargets} when another
   * surviving target renders the same display name. Never part of the wire
   * payload and never part of the "@Name" token.
   */
  disambiguator?: string;
}

export function mentionTypeForUid(uid: string): MentionParticipantType {
  const value = uid.trim().toLowerCase();
  return value.startsWith("agt_") || value.startsWith("agent:")
    ? "agent"
    : "human";
}

export function mentionPayloadTargets(
  mentions: readonly MentionTarget[],
): MentionTarget[] {
  return mentions.map((mention) => ({
    participantUid: mention.participantUid,
    participantType: mention.participantType,
    displayName: mention.displayName,
    ...(mention.email ? { email: mention.email } : {}),
  }));
}

export function mentionTargetsFromContacts(
  contacts: ReadonlyArray<{
    personUid?: string | null;
    participantUid?: string | null;
    displayName?: string | null;
    name?: string | null;
    email?: string | null;
    companyUid?: string | null;
    companyName?: string | null;
  }>,
): MentionTarget[] {
  const rows: MentionTarget[] = [];
  for (const contact of contacts) {
    const uid = (contact.personUid ?? contact.participantUid ?? "").trim();
    const displayName = (
      contact.displayName ??
      contact.name ??
      contact.email ??
      ""
    ).trim();
    if (!uid) continue;
    const participantType = mentionTypeForUid(uid);
    // Agents can arrive without an entity name (e.g. cross-company rosters in
    // group chats that have no companyUid). Fall back to a label derived from
    // the uid instead of dropping them; nameless non-agent rows still drop.
    const label =
      displayName ||
      (participantType === "agent" ? agentFallbackLabel(uid) : "");
    if (!label) continue;
    rows.push({
      participantUid: uid,
      participantType,
      displayName: label,
      ...(contact.email?.trim() ? { email: contact.email.trim() } : {}),
      // companyUid is the tenant this roster row belongs to — it is what lets
      // the picker tell two same-named agents from different companies apart.
      ...(contact.companyUid?.trim()
        ? { companyUid: contact.companyUid.trim() }
        : {}),
      ...(contact.companyName?.trim()
        ? { companyName: contact.companyName.trim() }
        : {}),
    });
  }
  // Dedupe by participantUid only — same-uid rows merge, distinct uids survive.
  return collapseDuplicateMentionTargets(rows);
}

/** Usable label for an agent whose roster row carries no name. */
export function agentFallbackLabel(uid: string): string {
  const bare = uid
    .trim()
    .replace(/^agent:/i, "")
    .replace(/^agt_/i, "");
  return bare ? `Agent ${bare.slice(0, 8)}` : "Agent";
}

/**
 * One picker row per IDENTITY. `participantUid` is the only true identity, so
 * it is the only dedupe key: two distinct uids ALWAYS both survive, even when
 * they share a display name and carry no email.
 *
 * Keying on display name (the previous behaviour) silently dropped one of two
 * same-named agents — e.g. a LiveRecover "Izzy" and an Indigo "Izzy" collapsed
 * to one row whose winner was decided by Map insertion order. That is how a
 * foreign-tenant agent got mentioned instead of the intended one, so a
 * cross-tenant incident was invisible in the UI. Never key on display name.
 *
 * Rows that really are the same uid still merge, preferring the richer/human
 * entry. Survivors that collide on display name get a rendered disambiguator
 * (see {@link disambiguateMentionTargets}) rather than being dropped.
 */
export function collapseDuplicateMentionTargets(
  targets: readonly MentionTarget[],
): MentionTarget[] {
  const byUid = new Map<string, MentionTarget>();
  for (const target of targets) {
    const uid = target.participantUid.trim();
    const email = (target.email ?? "").trim();
    const name = target.displayName.trim();
    // A row with no uid can never be mentioned, and a row with neither a name
    // nor an email can never be rendered or matched.
    if (!uid) continue;
    if (!name && !email) continue;
    const prev = byUid.get(uid);
    byUid.set(uid, prev ? mergeSameIdentity(prev, target) : target);
  }
  return disambiguateMentionTargets([...byUid.values()]);
}

/** Merge two rows already known to be the SAME participantUid. */
function mergeSameIdentity(
  prev: MentionTarget,
  next: MentionTarget,
): MentionTarget {
  // A human row beats an agent alias for the same uid (existing preference).
  const preferNext =
    prev.participantType === "agent" && next.participantType === "human";
  const base = preferNext ? next : prev;
  const other = preferNext ? prev : next;
  const merged: MentionTarget = {
    participantUid: base.participantUid,
    participantType: base.participantType,
    displayName: base.displayName.trim() || other.displayName,
  };
  // Fill each optional field from whichever row actually has it.
  const email = (base.email ?? other.email ?? "").trim();
  if (email) merged.email = email;
  const companyUid = (base.companyUid ?? other.companyUid ?? "").trim();
  if (companyUid) merged.companyUid = companyUid;
  const companyName = (base.companyName ?? other.companyName ?? "").trim();
  if (companyName) merged.companyName = companyName;
  return merged;
}

/** Key a display-name collision on: what the user actually reads in the row. */
function displayNameKey(target: MentionTarget): string {
  return target.displayName.trim().toLowerCase();
}

/**
 * Short, stable suffix of a uid — the last-resort disambiguator when a roster
 * row carries no company at all. Better an opaque suffix than a dropped row.
 */
function shortUidSuffix(uid: string): string {
  const bare = uid
    .trim()
    .replace(/^agent:/i, "")
    .replace(/^(agt|prs|cmp|co)_/i, "");
  const tail = bare || uid.trim();
  return tail.length > 6 ? `…${tail.slice(-6)}` : tail;
}

/** The label that tells two same-named targets apart. Company name first. */
export function mentionDisambiguatorFor(target: MentionTarget): string {
  const companyName = target.companyName?.trim();
  if (companyName) return companyName;
  const companyUid = target.companyUid?.trim();
  if (companyUid) return shortUidSuffix(companyUid);
  const email = target.email?.trim();
  if (email) return email;
  return shortUidSuffix(target.participantUid);
}

/**
 * Sort deterministically and attach a `disambiguator` to every target that
 * shares its display name with another survivor. Idempotent: a target whose
 * name no longer collides has any stale disambiguator cleared.
 */
export function disambiguateMentionTargets(
  targets: readonly MentionTarget[],
): MentionTarget[] {
  const sorted = [...targets].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      (a.email ?? "").localeCompare(b.email ?? "") ||
      // Same name and no email is exactly the cross-tenant case: fall through
      // to the uid so ordering never depends on input/insertion order.
      a.participantUid.localeCompare(b.participantUid),
  );
  const counts = new Map<string, number>();
  for (const target of sorted) {
    const key = displayNameKey(target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return sorted.map((target) => {
    const collides = (counts.get(displayNameKey(target)) ?? 0) > 1;
    if (!collides) {
      if (target.disambiguator === undefined) return target;
      const { disambiguator: _drop, ...rest } = target;
      return rest;
    }
    return { ...target, disambiguator: mentionDisambiguatorFor(target) };
  });
}

/** What the picker reads out: "Izzy (LiveRecover)" when the name collides. */
export function mentionTargetLabel(target: MentionTarget): string {
  const name = target.displayName.trim();
  return target.disambiguator ? `${name} (${target.disambiguator})` : name;
}

/** GET /v1/notify/contacts envelope or a bare list. */
export function mentionTargetsFromContactsPayload(
  raw: unknown,
): MentionTarget[] {
  if (Array.isArray(raw)) return mentionTargetsFromContacts(raw);
  if (!raw || typeof raw !== "object") return [];
  const rec = raw as Record<string, unknown>;
  const list = Array.isArray(rec.contacts) ? rec.contacts : [];
  return mentionTargetsFromContacts(list);
}

export function mergeMentionRosters(
  ...lists: Array<readonly MentionTarget[] | null | undefined>
): MentionTarget[] {
  const byId = new Map<string, MentionTarget>();
  for (const list of lists) {
    for (const row of list ?? []) {
      const uid = row.participantUid.trim();
      if (!uid) continue;
      const prev = byId.get(uid);
      byId.set(
        uid,
        prev
          ? {
              ...prev,
              ...row,
              // A later list must not blank a field an earlier list filled.
              email: prev.email ?? row.email,
              companyUid: prev.companyUid ?? row.companyUid,
              companyName: prev.companyName ?? row.companyName,
            }
          : row,
      );
    }
  }
  return collapseDuplicateMentionTargets([...byId.values()]);
}

export function activeMentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match ? (match[1]?.toLowerCase() ?? "") : null;
}

export function filterMentionCandidates(
  candidates: readonly MentionTarget[],
  query: string | null,
  selected: readonly MentionTarget[],
): MentionTarget[] {
  if (query === null) return [];
  const selectedIds = new Set(selected.map((target) => target.participantUid));
  return candidates
    .filter((candidate) => !selectedIds.has(candidate.participantUid))
    .filter((candidate) => {
      // Include the company so typing the tenant narrows a name collision.
      const haystack =
        `${candidate.displayName} ${candidate.email ?? ""} ${candidate.companyName ?? ""} ${candidate.disambiguator ?? ""}`.toLowerCase();
      return query.length === 0 || haystack.includes(query);
    })
    .slice(0, 30);
}

export function mentionTextForTarget(target: MentionTarget): string {
  return `@${target.displayName}`;
}

export function replaceActiveMention(
  text: string,
  mentionText: string,
): string {
  return text.replace(/(^|\s)@([^\s@]*)$/, (_match, prefix: string) => {
    return `${prefix}${mentionText} `;
  });
}

export function mergeMentionTargets(
  current: readonly MentionTarget[],
  incoming: MentionTarget,
): MentionTarget[] {
  const byId = new Map(current.map((row) => [row.participantUid, row]));
  byId.set(incoming.participantUid, incoming);
  return [...byId.values()];
}

export function mentionSpansForBody(
  body: string,
  mentions: readonly MentionTarget[],
): Array<{ start: number; end: number }> {
  const mentionTexts = [
    ...new Set(mentions.map((mention) => mentionTextForTarget(mention))),
  ]
    .filter((text) => text.length > 1)
    .sort((a, b) => b.length - a.length);
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < body.length) {
    const match = mentionTexts.find((text) => body.startsWith(text, index));
    if (!match) {
      index += 1;
      continue;
    }
    spans.push({ start: index, end: index + match.length });
    index += match.length;
  }
  return spans;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function mentionSegments(
  body: string,
  mentions: readonly MentionTarget[],
): Array<{ text: string; mention: boolean }> {
  const spans = mentionSpansForBody(body, mentions);
  if (spans.length === 0) return [{ text: body, mention: false }];
  const out: Array<{ text: string; mention: boolean }> = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      out.push({ text: body.slice(cursor, span.start), mention: false });
    }
    out.push({ text: body.slice(span.start, span.end), mention: true });
    cursor = span.end;
  }
  if (cursor < body.length)
    out.push({ text: body.slice(cursor), mention: false });
  return out;
}

/** Resolve a stored mention row's participant type.
 *  The wire field is optional, so fall back to the uid prefix rather than
 *  assuming "human" — an agent must never get a clickable profile link. */
export function storedMentionType(row: {
  participantUid: string;
  participantType?: string | null;
}): MentionParticipantType {
  const declared = row.participantType?.trim().toLowerCase();
  if (declared === "agent") return "agent";
  if (declared === "human") return "human";
  return mentionTypeForUid(row.participantUid ?? "");
}

interface MentionToken {
  token: string;
  target: MentionTarget;
}

/** Wrap mention tokens inside one run of message text (never inside a tag).
 *  Single left-to-right pass: inserted markup is not re-scanned, so a name
 *  that is a prefix of another can't be wrapped twice. */
function decorateMentionText(
  text: string,
  tokens: readonly MentionToken[],
): string {
  if (!text.includes("@")) return text;
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] === "@") {
      const hit = tokens.find(({ token }) => text.startsWith(token, cursor));
      if (hit) {
        const attrs =
          hit.target.participantType === "human" && hit.target.participantUid
            ? ` data-person-uid="${escapeHtml(hit.target.participantUid)}" data-person-type="human" role="button" tabindex="0"`
            : "";
        out += `<span class="inline-mention"${attrs}>${hit.token}</span>`;
        cursor += hit.token.length;
        continue;
      }
    }
    out += text[cursor];
    cursor += 1;
  }
  return out;
}

/** Highlight stored @names inside already-rendered markdown HTML.
 *  Human mentions carry `data-person-uid`/`data-person-type` so the shell can
 *  open the mentioned person's profile panel on click (agents get no uid).
 *  Tags are copied through verbatim: a name that also appears in an href or
 *  a title attribute must not have a <span> spliced into the markup. */
export function applyMentionMarkup(
  html: string,
  mentions: readonly MentionTarget[],
): string {
  // First target per display name wins the click target.
  const byName = new Map<string, MentionTarget>();
  for (const m of mentions) {
    const name = m.displayName.trim();
    if (name && !byName.has(name)) byName.set(name, m);
  }
  if (byName.size === 0) return html;
  // Longest name first so "@Ada Lovelace" beats "@Ada" at the same position.
  const tokens: MentionToken[] = [...byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => ({
      token: `@${escapeHtml(name)}`,
      target: byName.get(name)!,
    }));

  let out = "";
  let cursor = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    out += decorateMentionText(html.slice(cursor, textEnd), tokens);
    if (tagStart === -1) break;
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }
    out += html.slice(tagStart, tagEnd + 1);
    cursor = tagEnd + 1;
  }
  return out;
}
