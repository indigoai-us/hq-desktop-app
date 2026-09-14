// Composer `@`-mentions — the pure decisions, plus the two Tauri calls.
//
// Typing `@` at the start of a word opens a picker of the teammates and fleet
// agents in the session's company. Picking one inserts `@Display Name` into
// the draft AND records a chip `{ uid, displayName }`; the chip is the user's
// visible promise that this person will get a DM when the message is sent.
// The sent text keeps the `@Name` tokens (the CLI sees them as plain words),
// and the page DMs every recipient whose chip is still showing.
//
// Everything that decides WHAT the picker shows and WHAT a pick does is a pure
// function of (draft, caret, catalog, chips) below, so it is testable in the
// node suite. The two `invoke` wrappers at the bottom are the only Tauri
// surface; the Sessions page calls those instead of `invoke` directly, which
// keeps its "no raw invoke" contract intact.

import { invoke } from '@tauri-apps/api/core';

export type MentionKind = 'human' | 'agent';

/** One row the picker can offer — `session_mention_candidates`' shape. */
export interface MentionCandidate {
  uid: string;
  displayName: string;
  kind: MentionKind;
  /** People only; agents never carry a mailbox. */
  email?: string;
}

/** A kept mention: the chip under the textarea. */
export interface Mention {
  uid: string;
  displayName: string;
}

/** Per-recipient result of `session_mention_notify`. */
export interface MentionDelivery {
  uid: string;
  ok: boolean;
  error?: string;
}

/** The `@token` under the caret: where it starts, where the caret is, and the typed prefix. */
export interface MentionQuery {
  /** Index of the `@`. */
  start: number;
  /** Caret position — the end of the typed prefix. */
  end: number;
  /** What was typed after the `@`, raw (never contains whitespace). */
  query: string;
}

const WHITESPACE = /\s/;

/**
 * Read the token the caret sits in as a mention query.
 *
 * A query exists only while the caret is inside ONE `@word` token whose `@`
 * begins a word — at the start of the draft or after whitespace. That rule
 * keeps `a@b.com` (an email mid-word) and `hi @co rey` (the caret is past a
 * space, so the user is writing prose again) from popping a picker.
 */
export function mentionQueryAt(draft: string, caret: number): MentionQuery | null {
  const end = Math.max(0, Math.min(caret, draft.length));
  let start = -1;
  for (let i = end - 1; i >= 0; i -= 1) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch === '@') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  if (start > 0 && !WHITESPACE.test(draft.charAt(start - 1))) return null;
  return { start, end, query: draft.slice(start + 1, end) };
}

const lower = (value: string) => value.toLocaleLowerCase('en-US');

/** How well one candidate matches a typed prefix; lower is better, `null` is no match. */
function rank(candidate: MentionCandidate, prefix: string): number | null {
  const name = lower(candidate.displayName);
  if (name.startsWith(prefix)) return 0;
  if (name.split(/\s+/).some((word) => word.startsWith(prefix))) return 1;
  if (name.replace(/\s+/g, '').startsWith(prefix)) return 2;
  if (name.includes(prefix)) return 3;
  const local = candidate.email ? lower(candidate.email.split('@')[0] ?? '') : '';
  if (local && local.startsWith(prefix)) return 4;
  return null;
}

/**
 * The candidates to offer for a typed prefix, best match first.
 *
 * Ranking: a name that starts with the prefix, then a word of the name that
 * does (`ep` → "Corey Epstein"), then the name with its spaces removed
 * (`coreyep`), then a name that merely contains it, then an email's local
 * part. Ties keep the catalog's own order, which the backend already sorted
 * people-before-agents, alphabetically.
 */
export function filterMentionCandidates(
  candidates: ReadonlyArray<MentionCandidate>,
  query: string,
  limit = 8,
): MentionCandidate[] {
  const prefix = lower(query.trim());
  if (prefix.length === 0) return candidates.slice(0, limit);
  const ranked: Array<{ candidate: MentionCandidate; rank: number; index: number }> = [];
  candidates.forEach((candidate, index) => {
    const score = rank(candidate, prefix);
    if (score !== null) ranked.push({ candidate, rank: score, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

/** The literal text a mention occupies in the draft. */
export function mentionToken(mention: Pick<Mention, 'displayName'>): string {
  return `@${mention.displayName}`;
}

/**
 * Replace the `@prefix` token with `@Display Name ` and say where the caret
 * should land (just past the trailing space). A space is only added when the
 * text after the token does not already start with one.
 */
export function applyMention(
  draft: string,
  range: Pick<MentionQuery, 'start' | 'end'>,
  candidate: Pick<MentionCandidate, 'displayName'>,
): { draft: string; caret: number } {
  const token = mentionToken(candidate);
  const rest = draft.slice(range.end);
  const spacer = rest.length > 0 && WHITESPACE.test(rest.charAt(0)) ? '' : ' ';
  const head = draft.slice(0, range.start) + token + spacer;
  return { draft: head + rest, caret: head.length };
}

/** Keep one chip per recipient. */
export function addMention(mentions: ReadonlyArray<Mention>, candidate: MentionCandidate): Mention[] {
  if (mentions.some((mention) => mention.uid === candidate.uid)) return [...mentions];
  return [...mentions, { uid: candidate.uid, displayName: candidate.displayName }];
}

export function removeMention(mentions: ReadonlyArray<Mention>, uid: string): Mention[] {
  return mentions.filter((mention) => mention.uid !== uid);
}

/** True when `@Display Name` still appears in the draft as its own word. */
export function draftHasMention(draft: string, mention: Pick<Mention, 'displayName'>): boolean {
  const token = mentionToken(mention);
  let from = 0;
  while (from <= draft.length) {
    const at = draft.indexOf(token, from);
    if (at === -1) return false;
    const before = at === 0 || WHITESPACE.test(draft.charAt(at - 1));
    const afterIndex = at + token.length;
    const after = afterIndex >= draft.length || WHITESPACE.test(draft.charAt(afterIndex));
    if (before && after) return true;
    from = at + 1;
  }
  return false;
}

/**
 * The chips that still describe the draft: a mention whose `@Name` the user
 * deleted from the text is dropped, so a chip never promises a DM the message
 * no longer addresses.
 */
export function pruneMentions(mentions: ReadonlyArray<Mention>, draft: string): Mention[] {
  return mentions.filter((mention) => draftHasMention(draft, mention));
}

function listNames(names: ReadonlyArray<string>): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The confirmation under the draft: "Will DM Corey Epstein and Atlas". */
export function mentionSummary(mentions: ReadonlyArray<Mention>): string {
  if (mentions.length === 0) return '';
  return `Will DM ${listNames(mentions.map((mention) => mention.displayName))}`;
}

/** What the composer's footer says once the DMs went out — or did not. */
export function deliveryStatusLine(
  deliveries: ReadonlyArray<MentionDelivery>,
  mentions: ReadonlyArray<Mention>,
): { text: string; error: boolean } | null {
  if (deliveries.length === 0) return null;
  const nameOf = (uid: string) => mentions.find((mention) => mention.uid === uid)?.displayName ?? uid;
  const failed = deliveries.filter((delivery) => !delivery.ok);
  if (failed.length === 0) {
    return { text: `DM'd ${listNames(deliveries.map((delivery) => nameOf(delivery.uid)))}`, error: false };
  }
  const reasons = failed.map((delivery) => {
    const why = delivery.error?.trim();
    return why ? `${nameOf(delivery.uid)} (${why})` : nameOf(delivery.uid);
  });
  return { text: `Couldn't DM ${listNames(reasons)}`, error: true };
}

// ---------------------------------------------------------------------------
// Tauri
// ---------------------------------------------------------------------------

/** The people + agents mentionable in `company` (backend caches 60 s). */
export function loadMentionCandidates(company: string): Promise<MentionCandidate[]> {
  return invoke<MentionCandidate[]>('session_mention_candidates', { company });
}

export interface NotifyMentionsArgs {
  company: string;
  sessionId: string;
  recipients: string[];
  text: string;
  tool: string | null;
}

/** DM every recipient the message plus the session context line. */
export function notifyMentions(args: NotifyMentionsArgs): Promise<MentionDelivery[]> {
  return invoke<MentionDelivery[]>('session_mention_notify', {
    company: args.company,
    sessionId: args.sessionId,
    recipients: args.recipients,
    text: args.text,
    tool: args.tool,
  });
}
