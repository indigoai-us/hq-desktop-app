// Pure helpers for the agent "thinking" indicator (client-side optimistic
// status shown after a user @mentions a fleet agent in a channel / thread).
//
// The backend has no typing / ack / in-progress events, so the indicator is
// entirely local: we parse @mentions against the channel roster, start a
// per-agent timer when the mention send succeeds, downgrade the copy after a
// while, and clear the row when a message from that agent arrives (or the
// send fails, or the timer expires so a row can never stick forever).
//
// Keeping the mention parser + the state transitions here (not inside the
// .svelte components) makes them unit-testable without a DOM — mirrors
// lib/dmRequests.ts and lib/recipientPicker.ts. The controller
// (agentThinkingController.svelte.ts) owns the reactive $state, the member
// loader, and the tick interval. Injectable `now` on every transition so
// tests don't have to fake timers.

/** True when a personUid identifies a fleet agent. Reimplemented locally
 * (same prefixes as `isAgentSender` in lib/quickWindowPane.ts) so this
 * module doesn't couple to the notification-pane helpers. */
export function isAgentUid(uid: string): boolean {
  const u = uid.trim();
  return u.startsWith('agt_') || u.startsWith('agent_') || u.startsWith('agent:');
}

/** One roster row the mention parser can match against — a subset of
 * `ChannelMember` (we only need the uid + the name people actually type). */
export interface MentionCandidate {
  personUid: string;
  displayName: string;
}

/** Word-char test for mention boundaries. The `@` must not be preceded by a
 * word character (so `a@izzy.com` is not a mention of Izzy); the match must
 * also not be followed by a word character (so `@Iz` does not steal `@Izzy`).
 * ASCII `\w` — display names and typed mentions are Latin in practice. */
function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

/** Case-insensitive search for `@name` in `body` with word-char boundaries
 * on both sides. `name` is matched literally (spaces, parentheses, etc. are
 * fine — we don't go through a regex, so we don't have to escape). */
function hasAtMention(body: string, name: string): boolean {
  const needle = name.trim();
  if (!needle) return false;
  const haystack = body.toLowerCase();
  const target = `@${needle.toLowerCase()}`;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(target, from);
    if (idx < 0) return false;
    const before = idx > 0 ? haystack[idx - 1] : undefined;
    const after = haystack[idx + target.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = idx + 1;
  }
  return false;
}

/** First whitespace-delimited token of a display name (`"Izzy (Fleet)"` →
 * `"Izzy"`, `"Izzy Agent"` → `"Izzy"`). Empty when the name is blank. */
function firstNameToken(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** Agents @mentioned in `body`. A member matches when the body contains
 * `@` + their full displayName, or `@` + their first name token — both
 * case-insensitive, both word-boundary aware. Non-agent members are ignored.
 * Deduped by `personUid`, preserving roster order. */
export function detectAgentMentions(
  body: string,
  members: MentionCandidate[],
): MentionCandidate[] {
  const seen = new Set<string>();
  const matched: MentionCandidate[] = [];
  for (const member of members) {
    if (!isAgentUid(member.personUid)) continue;
    if (seen.has(member.personUid)) continue;
    const full = member.displayName.trim();
    if (!full) continue;
    const first = firstNameToken(full);
    const hit =
      hasAtMention(body, full) ||
      (first !== full && hasAtMention(body, first));
    if (!hit) continue;
    seen.add(member.personUid);
    matched.push(member);
  }
  return matched;
}

export type ThinkingPhase = 'thinking' | 'slow';

export interface ThinkingEntry {
  agentUid: string;
  agentName: string;
  startedAt: number;
  phase: ThinkingPhase;
}

const DEFAULT_SLOW_AFTER_MS = 150_000;
const DEFAULT_EXPIRE_AFTER_MS = 600_000;

/** Start (or restart) a thinking row for `agent`. Idempotent per `agentUid`:
 * a second start for the same agent replaces the existing row in place,
 * resetting `startedAt` and `phase` to `'thinking'` so a follow-up mention
 * doesn't stack rows and doesn't inherit a stale `'slow'` phase. Always
 * returns a NEW array. */
export function startThinking(
  entries: ThinkingEntry[],
  agent: { agentUid: string; agentName: string },
  now: number,
): ThinkingEntry[] {
  const next: ThinkingEntry = {
    agentUid: agent.agentUid,
    agentName: agent.agentName,
    startedAt: now,
    phase: 'thinking',
  };
  const idx = entries.findIndex((e) => e.agentUid === agent.agentUid);
  if (idx < 0) return [...entries, next];
  const copy = entries.slice();
  copy[idx] = next;
  return copy;
}

export interface TickOpts {
  /** Flip `'thinking'` → `'slow'` once the row is this old. Default 150s. */
  slowAfterMs?: number;
  /** Drop the row entirely once it's this old (no-stuck-forever). Default 600s. */
  expireAfterMs?: number;
}

/** Advance every row against `now`. Rows older than `expireAfterMs` are
 * removed; remaining rows older than `slowAfterMs` flip to `'slow'`. Always
 * returns a NEW array (the no-stuck-forever guarantee lives here, not in
 * the UI). */
export function tick(
  entries: ThinkingEntry[],
  now: number,
  opts?: TickOpts,
): ThinkingEntry[] {
  const slowAfterMs = opts?.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS;
  const expireAfterMs = opts?.expireAfterMs ?? DEFAULT_EXPIRE_AFTER_MS;
  const out: ThinkingEntry[] = [];
  for (const entry of entries) {
    const age = now - entry.startedAt;
    if (age >= expireAfterMs) continue;
    if (age >= slowAfterMs && entry.phase !== 'slow') {
      out.push({ ...entry, phase: 'slow' });
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Drop every row whose `agentUid` is in `agentUids`. Called when a message
 * from that agent arrives (their reply is the signal that they're no longer
 * silently working). Always returns a NEW array. */
export function clearForAgents(
  entries: ThinkingEntry[],
  agentUids: Iterable<string>,
): ThinkingEntry[] {
  const ids = new Set(agentUids);
  if (ids.size === 0) return entries.slice();
  return entries.filter((e) => !ids.has(e.agentUid));
}

/** Status copy for a row. Unicode ellipsis (U+2026) matches the rest of
 * the messaging UI (`Sending…`, `Joining…`). */
export function labelFor(entry: ThinkingEntry): string {
  if (entry.phase === 'slow') {
    return `${entry.agentName} is taking longer than usual…`;
  }
  return `${entry.agentName} is thinking…`;
}
