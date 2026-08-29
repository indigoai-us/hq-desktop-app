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
  }>,
): MentionTarget[] {
  const byId = new Map<string, MentionTarget>();
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
    byId.set(uid, {
      participantUid: uid,
      participantType,
      displayName: label,
      ...(contact.email?.trim() ? { email: contact.email.trim() } : {}),
    });
  }
  return collapseDuplicateMentionTargets([...byId.values()]);
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
 * One picker row per identity the user can tell apart. Distinct emails stay
 * distinct. Same display name with no email collapses (Scouty-style dupes).
 * Prefer a human uid over an agent alias.
 */
export function collapseDuplicateMentionTargets(
  targets: readonly MentionTarget[],
): MentionTarget[] {
  const byKey = new Map<string, MentionTarget>();
  for (const target of targets) {
    const email = (target.email ?? "").trim().toLowerCase();
    const name = target.displayName.trim().toLowerCase();
    if (!name && !email) continue;
    const key = email ? `email:${email}` : `name:${name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, target);
      continue;
    }
    const preferIncoming =
      prev.participantType === "agent" && target.participantType === "human";
    byKey.set(key, preferIncoming ? target : prev);
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      (a.email ?? "").localeCompare(b.email ?? ""),
  );
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
        prev ? { ...prev, ...row, email: prev.email ?? row.email } : row,
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
      const haystack =
        `${candidate.displayName} ${candidate.email ?? ""}`.toLowerCase();
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
