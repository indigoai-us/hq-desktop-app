// Pure helpers for HQ Rooms — agent identity, @mention autocomplete, and the
// structured mention list a room message carries (hq-rooms Slice 2).
//
// Why this is a lib and not component state: the server MENTION-GATES its
// room→agent-inbox delivery on these structured mentions. If the composer
// builds the list wrong, an @mention silently never reaches the agent — the
// exact "unresolvable mention fails silently" failure mode. That logic is
// worth unit-testing without a DOM, mirroring lib/channels.ts and
// lib/recipientPicker.ts. Components own invoke() + rendering only.

import type { ChannelMember } from './channels';

/** Prefixes that identify a fleet agent principal (mirrors quickWindowPane). */
const AGENT_PREFIXES = ['agt_', 'agent_', 'agent:'];

/** True when a person-uid identifies a fleet agent rather than a human. */
export function isAgentUid(personUid: string | null | undefined): boolean {
  const u = (personUid ?? '').trim();
  return AGENT_PREFIXES.some((p) => u.startsWith(p));
}

/** Participant kind as the server's mention schema spells it. */
export type ParticipantType = 'human' | 'agent';

export function participantTypeOf(personUid: string): ParticipantType {
  return isAgentUid(personUid) ? 'agent' : 'human';
}

/** One structured mention on an outgoing room message. */
export interface RoomMention {
  participantUid: string;
  participantType: ParticipantType;
  displayName: string;
}

/** A roster entry as the mention autocomplete sees it. */
export interface MentionCandidate {
  personUid: string;
  displayName: string;
  participantType: ParticipantType;
  /** Agents only: the owner shown as provenance ("run by Jacob"). */
  ownerDisplayName?: string;
}

/**
 * Build the autocomplete candidate list from a channel roster.
 * `selfUid` is excluded — you never @mention yourself. Entries with no usable
 * display name are dropped: an unnamed mention cannot be typed or resolved.
 */
export function mentionCandidates(
  members: ChannelMember[],
  selfUid: string,
  ownerNames: Record<string, string> = {},
): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  for (const m of members) {
    const uid = (m.personUid ?? '').trim();
    const name = (m.displayName ?? '').trim();
    if (!uid || uid === selfUid || !name) continue;
    const participantType = participantTypeOf(uid);
    const candidate: MentionCandidate = { personUid: uid, displayName: name, participantType };
    if (participantType === 'agent' && ownerNames[uid]) {
      candidate.ownerDisplayName = ownerNames[uid];
    }
    out.push(candidate);
  }
  // Agents first — the whole point of a room is reaching them — then humans,
  // each group alphabetical so the list is stable between renders.
  return out.sort((a, b) => {
    if (a.participantType !== b.participantType) {
      return a.participantType === 'agent' ? -1 : 1;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

/**
 * Filter candidates by the partial token typed after "@".
 * Case-insensitive prefix match on the display name, falling back to a
 * substring match so "@iz" finds "Izzy" and "@del" finds "Iris Delivery".
 */
export function filterCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return candidates;
  const starts = candidates.filter((c) => c.displayName.toLowerCase().startsWith(q));
  const contains = candidates.filter(
    (c) => !c.displayName.toLowerCase().startsWith(q) && c.displayName.toLowerCase().includes(q),
  );
  return [...starts, ...contains];
}

/**
 * The active "@" token at the caret, or null when the caret is not in one.
 * A token runs from an "@" that starts the text or follows whitespace, up to
 * the caret, and may not contain whitespace (mentions are single-token by the
 * time they are resolved against display names).
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1]!)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

/**
 * Replace the active "@" token with the chosen display name, returning the new
 * text and caret. A trailing space is appended so the next word does not glue
 * onto the mention (which would break server-side name resolution).
 */
export function applyMention(
  text: string,
  caret: number,
  candidate: MentionCandidate,
): { text: string; caret: number } {
  const active = activeMentionQuery(text, caret);
  if (!active) return { text, caret };
  const before = text.slice(0, active.start);
  const after = text.slice(caret);
  const inserted = `@${candidate.displayName} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/**
 * Resolve the structured mention list for an outgoing message by scanning the
 * body for "@<display name>" occurrences.
 *
 * Longest-name-first so "@Iris Delivery" is not shadowed by "@Iris". Matching
 * is case-insensitive and anchored at a word boundary. Deduped by uid: two
 * mentions of the same agent deliver one inbox item, not two.
 */
export function resolveMentions(body: string, candidates: MentionCandidate[]): RoomMention[] {
  const byLength = [...candidates].sort((a, b) => b.displayName.length - a.displayName.length);
  const lower = body.toLowerCase();
  const seen = new Set<string>();
  const out: RoomMention[] = [];
  for (const c of byLength) {
    const needle = `@${c.displayName.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const before = idx === 0 ? '' : body[idx - 1]!;
      const afterIdx = idx + needle.length;
      const after = afterIdx >= body.length ? '' : body[afterIdx]!;
      const boundedBefore = idx === 0 || /\s/.test(before);
      // A longer name starting with this one must not match the short one.
      const boundedAfter = afterIdx >= body.length || !/[\w-]/.test(after);
      if (boundedBefore && boundedAfter && !seen.has(c.personUid)) {
        seen.add(c.personUid);
        out.push({
          participantUid: c.personUid,
          participantType: c.participantType,
          displayName: c.displayName,
        });
        break;
      }
      from = idx + 1;
    }
  }
  return out;
}

/** True when the resolved mentions will wake at least one agent. */
export function mentionsAnyAgent(mentions: RoomMention[]): boolean {
  return mentions.some((m) => m.participantType === 'agent');
}

// ─── Agent activity state ────────────────────────────────────────────────────

/**
 * What a room shows for an agent member. Derived from the cheap signals the
 * agent box already emits (👀 seen / 💬 working reactions) plus its reply —
 * no observer-frame subsystem needed for v1.
 *
 * `working` is the state a human is waiting on, so it must never be silently
 * lost: `agentStateFrom` degrades a stale working signal to `stalled` rather
 * than back to `idle`, so the room never pretends nothing is happening
 * ("never go dark").
 */
export type AgentActivityState = 'idle' | 'seen' | 'working' | 'stalled' | 'replied';

/** How long a working signal stays fresh before it reads as stalled. */
export const AGENT_WORKING_STALE_MS = 3 * 60 * 1000;

export interface AgentSignal {
  /** Epoch ms of the most recent 👀 claim reaction, if any. */
  seenAt?: number | null;
  /** Epoch ms of the most recent 💬 working reaction, if any. */
  workingAt?: number | null;
  /** Epoch ms of the agent's most recent message in this room, if any. */
  repliedAt?: number | null;
}

export function agentStateFrom(
  signal: AgentSignal,
  now: number = Date.now(),
  staleMs: number = AGENT_WORKING_STALE_MS,
): AgentActivityState {
  const seen = signal.seenAt ?? 0;
  const working = signal.workingAt ?? 0;
  const replied = signal.repliedAt ?? 0;
  // A reply that lands after the work signal ends the turn.
  if (replied && replied >= working && replied >= seen) return 'replied';
  if (working) return now - working > staleMs ? 'stalled' : 'working';
  if (seen) return 'seen';
  return 'idle';
}

/** Short human label for an agent state — plain words, no jargon. */
export function agentStateLabel(state: AgentActivityState): string {
  switch (state) {
    case 'seen':
      return 'picked it up';
    case 'working':
      return 'working';
    case 'stalled':
      return 'still working';
    case 'replied':
      return 'replied';
    default:
      return 'idle';
  }
}
