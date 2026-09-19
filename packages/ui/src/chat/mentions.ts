/**
 * Structured channel mentions — same contract as hq-mobile / hq-pro.
 *
 * A mention is an entity (person prs_* or agent agt_*), not a work-mesh
 * thread. POST /v1/notify/channels/{id}/messages { mentions } adds anyone who
 * is not already on the channel roster to THAT ONE CHANNEL — including a
 * person from outside the channel's company, who joins as a channel guest with
 * read + post there and nothing else. Do not create a parallel work-mesh
 * thread for @-mentions.
 */

export type MentionParticipantType = "human" | "agent" | "broadcast";

/**
 * `@here` — one token that notifies everybody currently in this conversation.
 *
 * It travels as a single entry in the same `mentions[]` array as people:
 * `{ participantUid: "here", participantType: "broadcast" }`. The SERVER
 * expands it against the channel's live member set (hq-pro-core
 * `resolveChannelMentions` -> `expandHereMention`), so the app never sends a
 * list of uids for it and the roster can never go stale between compose and
 * send. It is exempt from the 25-mention cap, reaches people only (a bot still
 * needs its name typed), and is not offered in a 1:1 DM.
 */
export const HERE_MENTION_UID = "here";
export const HERE_MENTION_NAME = "here";

/** The picker row / draft target for `@here`. */
export function hereMentionTarget(): MentionTarget {
  return {
    participantUid: HERE_MENTION_UID,
    participantType: "broadcast",
    displayName: HERE_MENTION_NAME,
  };
}

export function isHereMention(target: {
  participantUid: string;
  participantType?: string | null;
}): boolean {
  return (
    target.participantType === "broadcast" &&
    target.participantUid.trim().toLowerCase() === HERE_MENTION_UID
  );
}

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
  return mentions.map((mention) =>
    // `@here` is a token, not an identity: it carries no display name and no
    // email, and the server reads only the two fields below.
    isHereMention(mention)
      ? {
          participantUid: HERE_MENTION_UID,
          participantType: "broadcast" as const,
          displayName: "",
        }
      : {
          participantUid: mention.participantUid,
          participantType: mention.participantType,
          displayName: mention.displayName,
          ...(mention.email ? { email: mention.email } : {}),
        },
  );
}

/**
 * Prepend the `@here` row to the picker's candidates when this conversation
 * supports it — every channel and group DM, never a 1:1 DM (there is one other
 * person and they are already notified). It sorts first so `@h` + Enter is the
 * fast path, and it is matched by the ordinary filter on its "here" name.
 */
export function withHereMention(
  candidates: readonly MentionTarget[],
  allowHere: boolean,
): MentionTarget[] {
  if (!allowHere) return [...candidates];
  const rest = candidates.filter((row) => !isHereMention(row));
  return [hereMentionTarget(), ...rest];
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
  return bare ? `Bot ${bare.slice(0, 8)}` : "Bot";
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
  options: MentionDisambiguationOptions = {},
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
  return disambiguateMentionTargets([...byUid.values()], options);
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

/** Options that control how a display-name collision is labelled. */
export interface MentionDisambiguationOptions {
  /**
   * What to show on a colliding HUMAN row that has neither a company nor an
   * email yet — "outside Indigo". The shell supplies it from the active
   * company, because this module has no view of the tenant.
   */
  outsideLabel?: string | null;
}

/** "outside Indigo" — the placeholder label for an unresolved outside person. */
export function outsideCompanyLabel(
  companyName: string | null | undefined,
): string | null {
  const name = companyName?.trim();
  return name ? `outside ${name}` : null;
}

/**
 * The label that tells two same-named targets apart. COMPANY NAME first, then
 * an email.
 *
 * A PERSON NEVER SEES A UID FRAGMENT. A human whose row came from the app-wide
 * display-name map carries only a uid and a name; the shell resolves that
 * person's email from the connections roster and the row relabels itself once
 * it arrives. Until then — and if the lookup fails — the row reads
 * `outsideLabel` ("outside Indigo"), which is true of every such row and tells
 * the user which of the two entries is the teammate they meant.
 *
 * The uid tag survives for AGENTS only. An agent has no email and often no
 * company, so on a collision there is genuinely nothing else to print, and two
 * identical unpickable agent rows is how the wrong tenant's agent gets
 * mentioned.
 */
export function mentionDisambiguatorFor(
  target: MentionTarget,
  options: MentionDisambiguationOptions = {},
): string | null {
  const companyName = target.companyName?.trim();
  if (companyName) return companyName;
  const email = target.email?.trim();
  if (email) return email;
  if (target.participantType === "agent") {
    const uid = target.participantUid.trim();
    return uid ? mentionUidTag(uid) : null;
  }
  return options.outsideLabel?.trim() || null;
}

/**
 * The uids whose email the shell still needs to fetch: colliding HUMAN rows
 * with no company and no email. Exported so the resolve-then-relabel flow is
 * testable without a component, and so the shell asks the server only about
 * rows a label would actually change.
 */
export function mentionUidsNeedingEmail(
  targets: readonly MentionTarget[],
): string[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = displayNameKey(target);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const uids: string[] = [];
  for (const target of targets) {
    if (target.participantType !== "human") continue;
    if (target.companyName?.trim() || target.email?.trim()) continue;
    if ((counts.get(displayNameKey(target)) ?? 0) < 2) continue;
    const uid = target.participantUid.trim();
    if (uid) uids.push(uid);
  }
  return uids;
}

/** Fill in emails resolved from the connections roster, keyed by uid. */
export function applyResolvedMentionEmails(
  targets: readonly MentionTarget[],
  emailByUid: Readonly<Record<string, string>>,
): MentionTarget[] {
  return targets.map((target) => {
    if (target.email?.trim()) return target;
    const resolved = emailByUid[target.participantUid.trim()]?.trim();
    return resolved ? { ...target, email: resolved } : target;
  });
}

/** A short, stable tail of a uid — a disambiguator of last resort, never a name. */
export function mentionUidTag(uid: string): string {
  const bare = uid
    .trim()
    .replace(/^agent:/i, "")
    .replace(/^(agt_|prs_)/i, "");
  return `id …${bare.slice(-6)}`;
}

/**
 * The pill beside the display name: the owning COMPANY when it is known, and
 * otherwise whatever label disambiguation settled on for a colliding row —
 * "outside Indigo" for an unresolved person, a uid tag for a same-named agent.
 * A row whose name does not collide carries no disambiguator and so shows no
 * pill. An email is never duplicated into the pill; it is already the human
 * row's subtitle.
 */
export function mentionRowPill(target: MentionTarget): string | null {
  const companyName = target.companyName?.trim();
  if (companyName) return companyName;
  const label = target.disambiguator?.trim();
  if (!label) return null;
  return label === target.email?.trim() ? null : label;
}

/** The row's subtitle: what kind of participant it is, or the human's email. */
export function mentionRowSubtitle(target: MentionTarget): string {
  if (isHereMention(target)) return "Notify everyone in this conversation";
  if (target.participantType === "agent") return "Bot";
  return target.email?.trim() || "Teammate";
}

/**
 * Stamp a tenant onto roster rows that arrived without one.
 *
 * `GET /v1/notify/contacts?companyUid=…` answers with rows that carry no
 * company field at all, even though the request itself was tenant-scoped. The
 * scope IS the row's company, so the client fills it in rather than waiting on
 * a server field; rows that already declare a company are left alone.
 */
export function stampMentionCompany(
  targets: readonly MentionTarget[],
  companyUid: string | null | undefined,
): MentionTarget[] {
  const uid = companyUid?.trim();
  if (!uid) return [...targets];
  return targets.map((target) =>
    target.companyUid?.trim() ? target : { ...target, companyUid: uid },
  );
}

/**
 * Sort deterministically and attach a `disambiguator` to every target that
 * shares its display name with another survivor. Idempotent: a target whose
 * name no longer collides has any stale disambiguator cleared.
 */
export function disambiguateMentionTargets(
  targets: readonly MentionTarget[],
  options: MentionDisambiguationOptions = {},
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
    const label = mentionDisambiguatorFor(target, options);
    if (!label) {
      if (target.disambiguator === undefined) return target;
      const { disambiguator: _stale, ...rest } = target;
      return rest;
    }
    return { ...target, disambiguator: label };
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
  _selected: readonly MentionTarget[],
): MentionTarget[] {
  if (query === null) return [];
  // A draft can mention someone repeatedly. Deduplicate notification recipients
  // in mergeMentionTargets, without removing them from the completion picker.
  return candidates
    .filter((candidate) => {
      // Include the company so typing the tenant narrows a name collision, and
      // the uids so pasting `agt_…`/`prs_…` still finds a row even though no id
      // is ever rendered.
      const haystack =
        `${candidate.displayName} ${candidate.email ?? ""} ${candidate.companyName ?? ""} ${candidate.disambiguator ?? ""} ${candidate.participantUid} ${candidate.companyUid ?? ""}`.toLowerCase();
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

/**
 * The stretches of a plain-text body that are CODE: fenced blocks (```…```)
 * and inline spans (`…`). An `@name` inside one of them is literal text, so it
 * is never chipped in the composer and never rides along on send.
 */
export function codeRegionsInBody(
  body: string,
): Array<{ start: number; end: number }> {
  const regions: Array<{ start: number; end: number }> = [];
  const fence = /```[\s\S]*?(?:```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(body)) !== null) {
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  const inFence = (index: number) =>
    regions.some((r) => index >= r.start && index < r.end);
  const inline = /`[^`\n]*`/g;
  while ((match = inline.exec(body)) !== null) {
    if (inFence(match.index)) continue;
    regions.push({ start: match.index, end: match.index + match[0].length });
  }
  return regions;
}

/**
 * A mention token only counts on a WORD BOUNDARY.
 *
 * Without this, "@here" matched inside "@heretic" and inside "nowhere@here",
 * chipping text the user never meant as a mention (and, for `@here`, sending a
 * broadcast they never asked for). The rule: nothing word-like or a second "@"
 * immediately before the token, nothing word-like immediately after it.
 */
function isMentionBoundary(body: string, start: number, end: number): boolean {
  const before = start > 0 ? body[start - 1]! : "";
  const after = end < body.length ? body[end]! : "";
  if (before && /[\w@]/.test(before)) return false;
  if (after && /\w/.test(after)) return false;
  return true;
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
  const code = codeRegionsInBody(body);
  const inCode = (index: number) =>
    code.some((r) => index >= r.start && index < r.end);
  const spans: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < body.length) {
    const match = inCode(index)
      ? undefined
      : mentionTexts.find(
          (text) =>
            body.startsWith(text, index) &&
            isMentionBoundary(body, index, index + text.length),
        );
    if (!match) {
      index += 1;
      continue;
    }
    spans.push({ start: index, end: index + match.length });
    index += match.length;
  }
  return spans;
}

/**
 * Keep only the mentions whose `@Name` text is still present in the body.
 * The composer remembers every target the user picked, but a pick the user
 * later deleted from the draft must not ride along on send — the server
 * invites every mentioned person to the channel, so a stale pick would
 * invite someone the sender deliberately removed.
 */
export function mentionsPresentInBody(
  body: string,
  mentions: readonly MentionTarget[],
): MentionTarget[] {
  const spans = mentionSpansForBody(body, mentions);
  const present = new Set(spans.map((span) => body.slice(span.start, span.end)));
  return mentions.filter((mention) =>
    present.has(mentionTextForTarget(mention)),
  );
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
      const hit = tokens.find(
        ({ token }) =>
          text.startsWith(token, cursor) &&
          isMentionBoundary(text, cursor, cursor + token.length),
      );
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
  // Markdown has already turned fences and inline spans into <pre>/<code>.
  // Text inside them is code the user typed literally, so it is copied through
  // untouched — "`@here`" renders as code, never as a mention chip.
  let codeDepth = 0;
  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const run = html.slice(cursor, textEnd);
    out += codeDepth > 0 ? run : decorateMentionText(run, tokens);
    if (tagStart === -1) break;
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }
    const tag = html.slice(tagStart, tagEnd + 1);
    const name = /^<\s*(\/?)\s*(code|pre)\b/i.exec(tag);
    if (name) codeDepth = name[1] ? Math.max(0, codeDepth - 1) : codeDepth + 1;
    out += tag;
    cursor = tagEnd + 1;
  }
  return out;
}

