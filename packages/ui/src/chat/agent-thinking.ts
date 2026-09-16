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
  /** Server timestamp (ms) of the newest message from this agent that was
   * already in the timeline when the row started. When set, only a message
   * NEWER than this clears the row — the clock-skew fallback in
   * `clearFromMessages` is not used. Needed for fast responders (local bots
   * answer in ~15–30 s): their previous reply falls inside the skew window
   * and would otherwise clear a fresh row on the very next catch-up. */
  afterMs?: number;
  /** Live status text the agent itself reported (`agent_status` wake). */
  detail?: string;
  /** When this agent started working, preserved across in-place restarts.
   * `startedAt` moves every time a new status arrives (it is the pin for the
   * clear rule); the elapsed counter must keep counting the whole turn, so it
   * reads this instead. */
  since?: number;
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
  opts?: { afterMs?: number; detail?: string },
): ThinkingEntry[] {
  const detail = opts?.detail?.trim();
  const next: ThinkingEntry = {
    agentUid: agent.agentUid,
    agentName: agent.agentName,
    startedAt: now,
    phase: 'thinking',
    ...(opts?.afterMs !== undefined && Number.isFinite(opts.afterMs)
      ? { afterMs: opts.afterMs }
      : {}),
    ...(detail ? { detail } : {}),
  };
  const idx = entries.findIndex((e) => e.agentUid === agent.agentUid);
  if (idx < 0) return [...entries, { ...next, since: now }];
  const copy = entries.slice();
  // A restart is the same stretch of work continuing (a fresh status, or a
  // follow-up mention while the agent is still going), so the elapsed counter
  // carries on from when it started rather than resetting to zero.
  copy[idx] = { ...next, since: entries[idx]!.since ?? entries[idx]!.startedAt };
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

/** Server/client clock skew allowance for `clearFromMessages`. A genuine
 * agent reply can carry a server timestamp slightly BEFORE the local
 * `startedAt` we recorded when the mention send resolved. */
const CLEAR_SKEW_MS = 120_000;

/** Timestamp-aware clear: drop a row only when a message from that agent is
 * NEWER than the row's `startedAt` (minus clock-skew allowance). Hosts that
 * re-fetch a whole thread on wake (ReplyPanel `load()`) must use this instead
 * of `clearForAgents`, or a historical agent reply from before the mention
 * would immediately kill a fresh row. Messages without a parseable
 * `createdAt` count as new (fail open — better to clear than to stick).
 * Always returns a NEW array. */
export function clearFromMessages(
  entries: ThinkingEntry[],
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
): ThinkingEntry[] {
  if (entries.length === 0 || messages.length === 0) return entries.slice();
  // uid -> newest message timestamp (NaN when any message had no timestamp).
  const newestByUid = new Map<string, number>();
  for (const msg of messages) {
    const uid = (msg.fromPersonUid ?? '').trim();
    if (!uid) continue;
    const ts = msg.createdAt ? Date.parse(msg.createdAt) : Number.NaN;
    const prev = newestByUid.get(uid);
    if (
      prev === undefined ||
      Number.isNaN(ts) ||
      (!Number.isNaN(prev) && ts > prev)
    ) {
      newestByUid.set(uid, ts);
    }
  }
  return entries.filter((entry) => {
    const newest = newestByUid.get(entry.agentUid);
    if (newest === undefined) return true;
    if (Number.isNaN(newest)) return false;
    if (entry.afterMs !== undefined) return newest <= entry.afterMs;
    return newest < entry.startedAt - CLEAR_SKEW_MS;
  });
}

/** Newest parseable `createdAt` (ms) among `messages` sent by `agentUid`, for
 * `startThinking`'s `afterMs`. Undefined when the agent has no timestamped
 * message yet (callers then fall back to the skew rule). */
export function newestMessageAtFrom(
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
  agentUid: string,
): number | undefined {
  const uid = agentUid.trim();
  let newest: number | undefined;
  for (const msg of messages) {
    if ((msg.fromPersonUid ?? '').trim() !== uid) continue;
    const ts = msg.createdAt ? Date.parse(msg.createdAt) : Number.NaN;
    if (Number.isNaN(ts)) continue;
    if (newest === undefined || ts > newest) newest = ts;
  }
  return newest;
}

/**
 * A bot created with a kickoff (`hq bot create --kickoff`) sends its intro and
 * then works on a first turn nobody asked for, so no send ever starts its
 * thinking row. Decide from that bot's messages in its DM:
 * - `waiting`: the intro has not landed yet;
 * - `start`: only the intro is there — show the row, pinned to the intro so
 *   the intro itself never clears it and the kickoff answer does;
 * - `done`: the answer already landed (or the DM already has more than the
 *   intro), so there is nothing left to wait for.
 */
export function kickoffThinkingState(
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
  agentUid: string,
): { state: 'waiting' } | { state: 'start'; afterMs: number } | { state: 'done' } {
  const uid = agentUid.trim();
  const fromBot = messages.filter((m) => (m.fromPersonUid ?? '').trim() === uid);
  if (fromBot.length === 0) return { state: 'waiting' };
  if (fromBot.length > 1) return { state: 'done' };
  const afterMs = newestMessageAtFrom(fromBot, uid);
  return afterMs === undefined ? { state: 'done' } : { state: 'start', afterMs };
}

/**
 * The name to show for an agent's thinking row. Never the name on a message
 * someone else wrote: a thread's root is often the person's own message, and
 * labelling the row with its author read "Jacob is thinking…" while the agent
 * worked. Order: the live roster name, the agent's own most recent message,
 * the caller's fallback (e.g. the DM title), then "Bot".
 */
export function agentDisplayName(
  agentUid: string,
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    fromDisplayName?: string | null;
  }>,
  opts?: { liveNames?: Record<string, string>; fallback?: string | null },
): string {
  const uid = agentUid.trim();
  const live = opts?.liveNames?.[uid]?.trim();
  if (live) return live;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if ((msg.fromPersonUid ?? '').trim() !== uid) continue;
    const name = msg.fromDisplayName?.trim();
    if (name) return name;
  }
  return opts?.fallback?.trim() || 'Bot';
}

/** An agent's own live status in a channel (hq-pro `agent_status` wake). */
export interface AgentStatusWake {
  channelId: string;
  agentUid: string;
  status: string;
  threadRoot?: string;
  /** Server publish time (ISO-8601). */
  ts: string;
}

/** Parse an `agent_status` payload (native event or raw MQTT JSON). */
export function parseAgentStatusWake(raw: unknown): AgentStatusWake | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec.type !== undefined && rec.type !== 'agent_status') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const channelId = str(rec.channelId);
  const agentUid = str(rec.agentUid);
  const ts = str(rec.ts);
  if (!channelId || !agentUid || !ts || Number.isNaN(Date.parse(ts))) return null;
  const threadRoot = str(rec.threadRoot);
  return {
    channelId,
    agentUid,
    status: str(rec.status).slice(0, 140),
    ts,
    ...(threadRoot ? { threadRoot } : {}),
  };
}

/**
 * Keep an agent's row up while the agent says it is working. Each status
 * restarts the row pinned to the status time, so only a message the agent
 * posts AFTER it clears the row: a progress post in the middle of a turn is
 * followed by a fresh status and the row comes straight back, and the final
 * answer (with no status after it) ends it. A status older than a message
 * the conversation already shows from that agent is stale and ignored.
 */
export function applyAgentStatus(
  entries: ThinkingEntry[],
  wake: AgentStatusWake,
  agentName: string,
  messages: ReadonlyArray<{ fromPersonUid?: string | null; createdAt?: string | null }>,
  now: number,
): ThinkingEntry[] {
  const at = Date.parse(wake.ts);
  if (Number.isNaN(at)) return entries.slice();
  const newest = newestMessageAtFrom(messages, wake.agentUid);
  if (newest !== undefined && newest >= at) return entries.slice();
  return startThinking(
    entries,
    { agentUid: wake.agentUid, agentName },
    now,
    { afterMs: at, detail: wake.status },
  );
}

// ---------------------------------------------------------------------------
// What the row SAYS over time.
//
// The row used to read "X is thinking…", flip once to "X is taking longer than
// usual…" at 150s, and then never change again — so a bot on a three-minute
// turn looked stuck. When the agent reports its own status we show that (and
// swap it each time a newer one arrives). With no status we walk a short set of
// honest phrases and, past 15s, append how long it has been working, the way a
// CLI agent does. None of this clears the row: teardown stays on a strictly
// newer message from that agent (see `clearFromMessages`).

/** Phrases walked, in order, while an agent works with no status of its own. */
export const THINKING_PHRASES = [
  'is thinking',
  'is reading the context',
  'is working on it',
  'is still working',
] as const;

/** How long each phrase holds before the next one. */
export const THINKING_PHRASE_ROTATE_MS = 8_000;
/** Past this, the row also shows how long the agent has been working. */
export const THINKING_ELAPSED_AFTER_MS = 15_000;

/** `42s`, `2m 10s` — the elapsed counter appended to a long-running row. */
export function formatThinkingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export interface ThinkingLine {
  /** The sentence, with no trailing ellipsis — the row animates its own. */
  label: string;
  /** `working for 42s`, or null before {@link THINKING_ELAPSED_AFTER_MS}. */
  elapsed: string | null;
}

export interface ThinkingLineOpts {
  rotateMs?: number;
  elapsedAfterMs?: number;
}

/**
 * What the row shows at `now`. A status the agent reported wins outright; with
 * none, the phrases walk on `rotateMs` and hold on the last one (they never
 * loop back to "is thinking" on a turn that has been going for minutes), and a
 * row `tick` has promoted to `'slow'` says so instead.
 */
export function thinkingLine(
  entry: ThinkingEntry,
  now: number,
  opts?: ThinkingLineOpts,
): ThinkingLine {
  const rotateMs = Math.max(1, opts?.rotateMs ?? THINKING_PHRASE_ROTATE_MS);
  const elapsedAfterMs = opts?.elapsedAfterMs ?? THINKING_ELAPSED_AFTER_MS;
  const workingMs = Math.max(0, now - (entry.since ?? entry.startedAt));

  const detail = entry.detail?.trim() ?? '';
  let label: string;
  if (detail && !/^is thinking/i.test(detail)) {
    // The agent's own words. "is …" reads as a sentence after the name;
    // anything else is a phrase and takes a colon.
    label = /^is\s/i.test(detail)
      ? `${entry.agentName} ${detail}`
      : `${entry.agentName}: ${detail}`;
  } else if (entry.phase === 'slow') {
    // `tick` promotes a row that has been going for `slowAfterMs`. Saying so
    // is more honest than another rotation of the same phrases.
    label = `${entry.agentName} is taking longer than usual`;
  } else {
    const index = Math.min(
      THINKING_PHRASES.length - 1,
      Math.floor(workingMs / rotateMs),
    );
    label = `${entry.agentName} ${THINKING_PHRASES[index]}`;
  }

  return {
    label: label.replace(/…+$/, ''),
    elapsed:
      workingMs >= elapsedAfterMs
        ? `working for ${formatThinkingElapsed(workingMs)}`
        : null,
  };
}

// ---------------------------------------------------------------------------
// Per-conversation map. The desktop shell keeps one flat list per OPEN row
// for a long time and wiped it on every row switch, so "Izzy is thinking…"
// vanished when the user peeked at another conversation and came back. The
// helpers below layer a `rowId → entries` map over the flat primitives so a
// row's optimistic status survives navigation and clears only on the signal
// that actually ends it: a NEWER message from that agent in THAT row (or a
// failed send in that row, or the hard expiry). Each helper returns a NEW
// object and never mutates its input; empty rows are dropped so the map does
// not accumulate keys for every conversation ever visited.

/** Thinking rows keyed by conversation row id (`dm:<uid>` / `ch:<channelId>`). */
export type ThinkingByRow = Record<string, ThinkingEntry[]>;

/** `startThinking` scoped to `rowId`. Returns a NEW map. */
export function startThinkingIn(
  map: ThinkingByRow,
  rowId: string,
  agent: { agentUid: string; agentName: string },
  now: number,
  opts?: { afterMs?: number },
): ThinkingByRow {
  return { ...map, [rowId]: startThinking(map[rowId] ?? [], agent, now, opts) };
}

/** `tick` applied to every row; rows left empty by the expiry are removed.
 * Returns a NEW map. */
export function tickAll(
  map: ThinkingByRow,
  now: number,
  opts?: TickOpts,
): ThinkingByRow {
  const out: ThinkingByRow = {};
  for (const [rowId, entries] of Object.entries(map)) {
    const next = tick(entries, now, opts);
    if (next.length > 0) out[rowId] = next;
  }
  return out;
}

/** `clearFromMessages` scoped to `rowId` (messages from another conversation
 * must never clear this row's status). A row left empty is removed. Returns
 * a NEW map. */
export function clearRowFromMessages(
  map: ThinkingByRow,
  rowId: string,
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
): ThinkingByRow {
  const entries = map[rowId];
  if (!entries || entries.length === 0) return { ...map };
  const next = clearFromMessages(entries, messages);
  if (next.length === entries.length) return { ...map };
  return dropOrSet(map, rowId, next);
}

/** Remove every row for `rowId` (failed send in that conversation). Returns
 * a NEW map. */
export function dropRow(map: ThinkingByRow, rowId: string): ThinkingByRow {
  return dropOrSet(map, rowId, []);
}

function dropOrSet(
  map: ThinkingByRow,
  rowId: string,
  entries: ThinkingEntry[],
): ThinkingByRow {
  const { [rowId]: _dropped, ...rest } = map;
  return entries.length > 0 ? { ...rest, [rowId]: entries } : rest;
}

/** `clearForAgents` applied to EVERY row: the agent is known not to be
 * working anywhere (its start/turn failed definitively, which is the newer
 * event that ends the row — never a timer). Rows left empty are removed.
 * Returns a NEW map. */
export function clearAgentEverywhere(
  map: ThinkingByRow,
  agentUid: string,
): ThinkingByRow {
  const uid = agentUid.trim();
  if (!uid) return map;
  const out: ThinkingByRow = {};
  let changed = false;
  for (const [rowId, entries] of Object.entries(map)) {
    const next = clearForAgents(entries, [uid]);
    if (next.length !== entries.length) changed = true;
    if (next.length > 0) out[rowId] = next;
  }
  return changed ? out : map;
}
