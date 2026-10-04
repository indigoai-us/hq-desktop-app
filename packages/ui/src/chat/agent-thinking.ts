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
  /** Local time (ms) the agent's newest status for this row arrived. Set only
   * by a status the agent itself sent (`applyDmAgentStatus`); a row that has
   * it ends once the agent goes quiet for {@link STATUS_SILENT_AFTER_MS}. A
   * row without it never received a status and keeps the slow and expiry
   * timers. */
  lastStatusAt?: number;
  /** The DM thread root the agent said it is working in, kept for a later
   * per-thread indicator. It does not change where the row draws. */
  rootEventId?: string;
  /** The agent reported at least one status of its own on this row, in this
   * turn or an earlier one. Unlike `lastStatusAt` it is kept when the person
   * writes again, so the row still says this is a bot that reports what it
   * is doing. Nothing the person sees depends on it: the 90 s rule reads
   * `lastStatusAt` only. The end-of-row log line reads it (see
   * {@link thinkingEndedLogLine}). */
  statusSeen?: true;
  /** The event id of the person's message whose send started (or last
   * restarted) this row, when a send did. It lets the "stopped responding"
   * sentence recognise that message by identity, with no clock involved
   * (see {@link stoppedRespondingApplies}). */
  askedEventId?: string;
}

/** What `startThinking` may be told about the start. */
export interface StartThinkingOpts {
  afterMs?: number;
  detail?: string;
  /**
   * The person just sent this agent a message: a new ask. The row remembers
   * the sent message's event id (when the send returned one) and forgets
   * when the agent last reported a status. That status belonged to the work
   * before this message, and counting the agent's silence from it would end
   * the row moments after the person wrote. The 90 s rule applies again from
   * the agent's next status.
   *
   * That a status was ever seen stays on the row (`statusSeen`). A turn that
   * then gets no status and no message keeps the long timers, as a row that
   * never had a status does: "taking longer than usual" at 150 s, gone at
   * 600 s, and nothing said. Saying "stopped responding" there would be a
   * guess: a bot that is slow to pick the message up has sent no status yet
   * either.
   */
  asked?: { eventId?: string | null };
}

const DEFAULT_SLOW_AFTER_MS = 150_000;
const DEFAULT_EXPIRE_AFTER_MS = 600_000;
/** A row whose agent has reported a status ends after this long with no
 * further status (the bot sends one at least every 20 s while it works). */
export const STATUS_SILENT_AFTER_MS = 90_000;

/** Start (or restart) a thinking row for `agent`. Idempotent per `agentUid`:
 * a second start for the same agent replaces the existing row in place,
 * resetting `startedAt` and `phase` to `'thinking'` so a follow-up mention
 * doesn't stack rows and doesn't inherit a stale `'slow'` phase. A restart
 * that carries no pin keeps the existing row's pin: without it the row fell
 * back to the clock-skew rule, and an agent message from up to two minutes
 * BEFORE the restart (already on screen) ended it on the next page fetch.
 * Always returns a NEW array. */
export function startThinking(
  entries: ThinkingEntry[],
  agent: { agentUid: string; agentName: string },
  now: number,
  opts?: StartThinkingOpts,
): ThinkingEntry[] {
  const detail = opts?.detail?.trim();
  const askedEventId = opts?.asked?.eventId?.trim() || undefined;
  const idx = entries.findIndex((e) => e.agentUid === agent.agentUid);
  const pinned =
    opts?.afterMs !== undefined && Number.isFinite(opts.afterMs)
      ? opts.afterMs
      : idx >= 0
        ? entries[idx]!.afterMs
        : undefined;
  const next: ThinkingEntry = {
    agentUid: agent.agentUid,
    agentName: agent.agentName,
    startedAt: now,
    phase: 'thinking',
    ...(pinned !== undefined ? { afterMs: pinned } : {}),
    ...(detail ? { detail } : {}),
  };
  if (idx < 0) return [...entries, { ...next, since: now, ...(askedEventId ? { askedEventId } : {}) }];
  const copy = entries.slice();
  // A restart is the same stretch of work continuing (a fresh status, or a
  // follow-up mention while the agent is still going), so the elapsed counter
  // carries on from when it started rather than resetting to zero. What the
  // agent last reported about itself (when, and in which thread) stays too.
  const prev = entries[idx]!;
  if (opts?.asked) {
    // The person wrote again (see StartThinkingOpts.asked): the row is now
    // for that message, and the silence clock waits for the next status.
    copy[idx] = {
      ...next,
      since: prev.since ?? prev.startedAt,
      ...(prev.rootEventId ? { rootEventId: prev.rootEventId } : {}),
      ...(prev.statusSeen ? { statusSeen: true as const } : {}),
      ...(askedEventId ? { askedEventId } : {}),
    };
    return copy;
  }
  copy[idx] = {
    ...next,
    since: prev.since ?? prev.startedAt,
    ...(prev.lastStatusAt !== undefined ? { lastStatusAt: prev.lastStatusAt } : {}),
    ...(prev.statusSeen ? { statusSeen: true as const } : {}),
    ...(prev.rootEventId ? { rootEventId: prev.rootEventId } : {}),
    ...(prev.askedEventId ? { askedEventId: prev.askedEventId } : {}),
  };
  return copy;
}

export interface TickOpts {
  /** Flip `'thinking'` → `'slow'` once the row is this old. Default 150s. */
  slowAfterMs?: number;
  /** Drop the row entirely once it's this old (no-stuck-forever). Default 600s. */
  expireAfterMs?: number;
}

/** Advance every row against `now`. Rows older than `expireAfterMs` are
 * removed; remaining rows older than `slowAfterMs` flip to `'slow'`. Returns
 * the SAME `entries` reference when nothing changed (no row expired or
 * flipped phase, including the empty-input case) so callers polling on an
 * interval can assign the result to `$state` without minting a new identity
 * every tick. Returns a NEW array only when at least one row changed (the
 * no-stuck-forever guarantee lives here, not in the UI). */
export function tick(
  entries: ThinkingEntry[],
  now: number,
  opts?: TickOpts,
): ThinkingEntry[] {
  const slowAfterMs = opts?.slowAfterMs ?? DEFAULT_SLOW_AFTER_MS;
  const expireAfterMs = opts?.expireAfterMs ?? DEFAULT_EXPIRE_AFTER_MS;
  const out: ThinkingEntry[] = [];
  let changed = false;
  for (const entry of entries) {
    const age = now - entry.startedAt;
    if (age >= expireAfterMs) {
      changed = true;
      continue;
    }
    if (age >= slowAfterMs && entry.phase !== 'slow') {
      changed = true;
      out.push({ ...entry, phase: 'slow' });
    } else {
      out.push(entry);
    }
  }
  return changed ? out : entries;
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
 * A server time this far before the local time a request was sent still
 * counts as after it: the two clocks need not agree to the second.
 */
export const HELLO_ASK_SKEW_MS = 5_000;

/**
 * The app asked a new cloud bot for its first message (a hidden request) and
 * the person reached the conversation. Decide, from the loaded timeline,
 * whether the bot should show as working:
 * - `done`: the bot has written since the ask (its hello is already there),
 *   or the ask is older than a row would have lived anyway, or its time is
 *   not usable. No row: nothing is in flight that the person is waiting on.
 * - `start`: nothing from the bot since the ask. The row starts as of the
 *   ask (`startedAt`), so it ends no later than a row started then would
 *   have, pinned to the bot's newest message so only a newer one ends it.
 *
 * Call it only once the conversation's timeline has loaded: an empty
 * timeline that is still loading says nothing about what the bot wrote.
 */
export function helloThinkingState(
  messages: ReadonlyArray<{
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
  agentUid: string,
  askedAtMs: number | null | undefined,
  now: number,
  opts?: { expireAfterMs?: number },
): { state: 'start'; startedAt: number; afterMs?: number } | { state: 'done' } {
  if (typeof askedAtMs !== 'number' || !Number.isFinite(askedAtMs)) return { state: 'done' };
  const newest = newestMessageAtFrom(messages, agentUid);
  if (newest !== undefined && newest >= askedAtMs - HELLO_ASK_SKEW_MS) return { state: 'done' };
  if (now - askedAtMs >= (opts?.expireAfterMs ?? DEFAULT_EXPIRE_AFTER_MS)) return { state: 'done' };
  return { state: 'start', startedAt: Math.min(askedAtMs, now), ...(newest !== undefined ? { afterMs: newest } : {}) };
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

/**
 * An agent's own live status in a 1:1 DM with a person (hq-pro `agent_status`
 * wake from POST /v1/notify/dm/{peerUid}/agent-status). It carries no
 * `channelId`: `withPersonUid` is the person the DM is with and `agentUid` is
 * the other side, so it belongs to the row `dm:<agentUid>`.
 */
export interface DmAgentStatusWake {
  agentUid: string;
  /** The person the DM is with (the owner of the topic the wake arrived on). */
  withPersonUid: string;
  status: string;
  /** Server publish time (ISO-8601). */
  ts: string;
  /** When the bot's own machine created the status (ISO-8601 UTC), when the
   * wake carries it. It is the better time to judge a late status by: a
   * status can be created before the reply and published after it. */
  sentAt?: string;
  /** The DM thread root the agent is working in, when it said. */
  rootEventId?: string;
}

/**
 * Parse the DM shape of an `agent_status` payload (native event or raw MQTT
 * JSON). A payload with a `channelId` is the channel shape and is not this
 * one. Unknown fields are ignored.
 */
export function parseDmAgentStatusWake(raw: unknown): DmAgentStatusWake | null {
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
  if (str(rec.channelId)) return null;
  const agentUid = str(rec.agentUid);
  const withPersonUid = str(rec.withPersonUid);
  const ts = str(rec.ts);
  if (!agentUid || !withPersonUid || !ts || Number.isNaN(Date.parse(ts))) return null;
  const sentAt = str(rec.sentAt);
  const rootEventId = str(rec.rootEventId);
  return {
    agentUid,
    withPersonUid,
    status: str(rec.status).slice(0, 140),
    ts,
    ...(sentAt && !Number.isNaN(Date.parse(sentAt)) ? { sentAt } : {}),
    ...(rootEventId ? { rootEventId } : {}),
  };
}

/**
 * The messages a DM status is judged and pinned against: the timeline the
 * app holds for that DM, plus the bot's newest message announced by a wake
 * (`announcedAt`, ISO time), which the timeline may not hold yet. A DM that
 * is not open may have no timeline in the app at all, and one that is open
 * can be a page behind the wake.
 *
 * Both the late-status check and the pin read this one list, so a status
 * created after an announced reply is pinned to that reply: the reply
 * arriving on the next page then cannot end the row the newer status began.
 */
export function heldDmMessages<M extends { fromPersonUid?: string | null; createdAt?: string | null }>(
  timeline: ReadonlyArray<M>,
  agentUid: string,
  announcedAt: string | null | undefined,
): ReadonlyArray<M | { fromPersonUid: string; createdAt: string }> {
  const at = (announcedAt ?? '').trim();
  if (!at || Number.isNaN(Date.parse(at))) return timeline;
  return [...timeline, { fromPersonUid: agentUid.trim(), createdAt: at }];
}

/** When a DM status was created (ms): the bot's `sentAt` when the wake has
 * one, else the server's publish time. NaN when neither parses. */
export function dmAgentStatusCreatedAt(wake: DmAgentStatusWake): number {
  const sent = wake.sentAt ? Date.parse(wake.sentAt) : Number.NaN;
  return Number.isNaN(sent) ? Date.parse(wake.ts) : sent;
}

/** A bot's DM statuses are applied at most this often per bot. */
export const DM_STATUS_APPLY_MIN_INTERVAL_MS = 1_000;

export interface StatusCoalescer<T> {
  /** Hand in a value for `key`: applied now, or held and applied when its turn comes. */
  push(key: string, value: T): void;
  /** Drop everything held and cancel every timer. Nothing is applied. */
  dispose(): void;
}

/**
 * Apply values per key at most once per `minIntervalMs`, always the newest.
 *
 * The first value for a key is applied at once. Values that arrive within
 * the interval after an apply are held: only the newest is kept, and it is
 * applied when the interval is over. So one bot sending many statuses a
 * second costs one apply (one reactive write) a second, the row still shows
 * the first status without delay, and the last status always lands.
 *
 * Nothing here rate-limits the sender. A bot's status wakes arrive at
 * whatever rate the server relays them; this bounds what the app does with
 * them. `newer` says which of two held values to keep (default: the one
 * pushed last). The clock and timers can be handed in for tests.
 */
export function createStatusCoalescer<T>(opts: {
  apply: (key: string, value: T) => void;
  minIntervalMs?: number;
  newer?: (candidate: T, held: T) => boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): StatusCoalescer<T> {
  const interval = Math.max(0, opts.minIntervalMs ?? DM_STATUS_APPLY_MIN_INTERVAL_MS);
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const newer = opts.newer ?? (() => true);
  interface Slot {
    appliedAt: number;
    held?: { value: T };
    timer?: unknown;
  }
  const slots = new Map<string, Slot>();
  let disposed = false;
  /** Keys with nothing held and nothing applied lately carry no state worth keeping. */
  const MAX_IDLE_SLOTS = 200;

  function prune(at: number): void {
    if (slots.size <= MAX_IDLE_SLOTS) return;
    for (const [key, slot] of slots) {
      if (slot.timer === undefined && at - slot.appliedAt >= interval) slots.delete(key);
    }
  }

  return {
    push(key, value) {
      if (disposed) return;
      const at = now();
      const slot = slots.get(key);
      if (!slot || (slot.timer === undefined && at - slot.appliedAt >= interval)) {
        slots.set(key, { appliedAt: at });
        prune(at);
        opts.apply(key, value);
        return;
      }
      if (!slot.held || newer(value, slot.held.value)) slot.held = { value };
      if (slot.timer !== undefined) return;
      slot.timer = setTimer(() => {
        slot.timer = undefined;
        const held = slot.held;
        slot.held = undefined;
        if (disposed || !held) return;
        slot.appliedAt = now();
        opts.apply(key, held.value);
      }, Math.max(0, slot.appliedAt + interval - at));
    },
    dispose() {
      disposed = true;
      for (const slot of slots.values()) {
        if (slot.timer !== undefined) clearTimer(slot.timer);
      }
      slots.clear();
    },
  };
}

/**
 * A bot says it is working in its DM: start its row, or refresh the one that
 * is there, with the status text and the time the status arrived.
 *
 * `messages` is the timeline the app holds for that DM. A status created
 * (`sentAt`, else `ts`) at or before the bot's newest message there is late
 * (the reply already landed) and changes nothing: the SAME array comes back.
 * The row is pinned to `opts.afterMs` (the bot's newest message at this
 * moment), so only a newer message from the bot ends it; with no pin given, a
 * row that is already pinned keeps its pin.
 *
 * There is one row per DM whatever thread the status names: with two threads
 * running for the same person, a status for either means the bot is working.
 * The newest status's `rootEventId` is kept on the row and nothing else
 * changes with it.
 */
export function applyDmAgentStatus(
  entries: ThinkingEntry[],
  wake: DmAgentStatusWake,
  agentName: string,
  messages: ReadonlyArray<{ fromPersonUid?: string | null; createdAt?: string | null }>,
  now: number,
  opts?: { afterMs?: number },
): ThinkingEntry[] {
  const at = dmAgentStatusCreatedAt(wake);
  if (Number.isNaN(at)) return entries;
  const newest = newestMessageAtFrom(messages, wake.agentUid);
  if (newest !== undefined && newest >= at) return entries;
  const started = startThinking(
    entries,
    { agentUid: wake.agentUid, agentName },
    now,
    { afterMs: opts?.afterMs ?? newest, detail: wake.status },
  );
  return started.map((entry) => {
    if (entry.agentUid !== wake.agentUid) return entry;
    const { rootEventId: _previous, ...rest } = entry;
    return {
      ...rest,
      lastStatusAt: now,
      statusSeen: true as const,
      ...(wake.rootEventId ? { rootEventId: wake.rootEventId } : {}),
    };
  });
}

/**
 * Drop every row whose agent reported a status and has now been quiet for
 * `silentAfterMs`: no further status, and no message (a message from the
 * agent ends the row by itself). Rows that never received a status are left
 * to `tick`. Same array when nothing ended.
 *
 * `clockRestartedAt` is the last moment the app could not have heard a
 * status (the window was hidden, the Mac slept, the wake connection was
 * down; see {@link statusSilenceClockRestarts}). The quiet is counted from
 * the later of that and the row's last status, so a gap in listening is
 * never read as the agent going quiet.
 */
export function endStatusSilent(
  entries: ThinkingEntry[],
  now: number,
  silentAfterMs: number = STATUS_SILENT_AFTER_MS,
  clockRestartedAt?: number,
): ThinkingEntry[] {
  const floor = clockRestartedAt !== undefined && Number.isFinite(clockRestartedAt) ? clockRestartedAt : Number.NEGATIVE_INFINITY;
  const kept = entries.filter(
    (entry) => entry.lastStatusAt === undefined || now - Math.max(entry.lastStatusAt, floor) < silentAfterMs,
  );
  return kept.length === entries.length ? entries : kept;
}

/**
 * A gap between two silence checks longer than this means the checks did not
 * run for a while (the Mac slept, the webview was suspended). The checks run
 * every 5 s, so three missed in a row is not ordinary timer jitter.
 */
export const STATUS_SILENCE_CHECK_GAP_MS = 15_000;

/**
 * Whether this silence check must restart the 90 s clock instead of ending
 * rows. Status wakes ride MQTT at QoS 0: while the app was not listening,
 * statuses were lost, and a row must not end with "stopped responding"
 * because of that.
 *
 * The clock restarts when the window is hidden now, and on the first check
 * after a stretch in which the checks did not run. The host also restarts it
 * when the window becomes visible again and when the wake connection
 * reconnects. After a restart the bot has the full 90 s to report again or
 * to answer.
 */
export function statusSilenceClockRestarts(input: {
  now: number;
  /** When the previous check ran (ms), or null for the first one. */
  previousCheckAt: number | null;
  /** The window is hidden right now. */
  hidden: boolean;
  gapMs?: number;
}): boolean {
  if (input.hidden) return true;
  if (input.previousCheckAt === null) return false;
  return input.now - input.previousCheckAt > (input.gapMs ?? STATUS_SILENCE_CHECK_GAP_MS);
}

/** What the conversation says once a row ended because the bot went quiet. */
export function stoppedRespondingLine(agentName: string): string {
  return `${agentName.trim() || 'Bot'} stopped responding. Try again.`;
}

/** What the app keeps about a DM row that ended because its bot went quiet. */
export interface StoppedResponding {
  /** The name on the row. */
  name: string;
  /** When the row began (local ms). */
  since: number;
  /** The person's message whose send started the row, when a send did. */
  askedEventId?: string;
}

/** The record to keep for a row that just ended for silence. */
export function stoppedRespondingFrom(entry: ThinkingEntry): StoppedResponding {
  return {
    name: entry.agentName,
    since: entry.since ?? entry.startedAt,
    ...(entry.askedEventId ? { askedEventId: entry.askedEventId } : {}),
  };
}

/**
 * Whether the DM says "<Name> stopped responding. Try again." for a row that
 * ended because its bot went quiet.
 *
 * It says so only when the person's own message is the newest message in the
 * conversation: the person asked, the bot said it was working, and nothing
 * came back. In every other case the row ends silently:
 *
 * - the newest message is the bot's: it answered, or at least wrote last;
 * - the newest message is newer than the row's start: something happened in
 *   the conversation after the row began, so the row was not about it;
 * - the conversation is not loaded, has no message, or the order cannot be
 *   told (a bot message with no readable time).
 *
 * `messages` are the rows the person can see (any order). Whose message is
 * newest is decided between server times only. The one comparison against a
 * local time (`since`) is skipped when the newest message is the very
 * message whose send started the row (`askedEventId`); otherwise a clock
 * that disagrees with the server can only turn the sentence off, or leave it
 * on under a message of the person's that is still the last one.
 */
export function stoppedRespondingApplies(
  note: StoppedResponding,
  messages: ReadonlyArray<{
    eventId?: string | null;
    fromPersonUid?: string | null;
    createdAt?: string | null;
  }>,
  who: { agentUid: string; selfUid: string | null | undefined },
): boolean {
  const agentUid = who.agentUid.trim();
  const selfUid = (who.selfUid ?? '').trim();
  if (!agentUid || !selfUid || selfUid === agentUid) return false;
  let newest: { eventId: string; from: string; at: number } | null = null;
  for (const msg of messages) {
    const from = (msg.fromPersonUid ?? '').trim();
    const at = msg.createdAt ? Date.parse(msg.createdAt) : Number.NaN;
    if (Number.isNaN(at)) {
      // A bot message that cannot be placed in time may be its answer.
      if (from === agentUid) return false;
      continue;
    }
    // On a tie the bot's message counts as the newer one.
    if (!newest || at > newest.at || (at === newest.at && from === agentUid)) {
      newest = { eventId: (msg.eventId ?? '').trim(), from, at };
    }
  }
  if (!newest || newest.from !== selfUid) return false;
  if (note.askedEventId && newest.eventId === note.askedEventId) return true;
  return newest.at <= note.since;
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
  opts?: Pick<StartThinkingOpts, 'afterMs' | 'asked'>,
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

/** `endStatusSilent` applied to every row; rows left empty are removed. Same
 * map when nothing ended. */
export function endStatusSilentAll(
  map: ThinkingByRow,
  now: number,
  silentAfterMs: number = STATUS_SILENT_AFTER_MS,
  clockRestartedAt?: number,
): ThinkingByRow {
  const out: ThinkingByRow = {};
  let changed = false;
  for (const [rowId, entries] of Object.entries(map)) {
    const next = endStatusSilent(entries, now, silentAfterMs, clockRestartedAt);
    if (next !== entries) changed = true;
    if (next.length > 0) out[rowId] = next;
  }
  return changed ? out : map;
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

/**
 * Reconcile the thinking rows with the bots that are answering right now.
 *
 * `busy` comes from the local bots listing (the CLI's in-flight markers). A
 * bot that just started answering gets a row in its own DM; a bot that has
 * finished loses its rows everywhere. Pure: returns a NEW map.
 */
export function syncBusyThinking(
  map: ThinkingByRow,
  opts: {
    busy: readonly string[];
    previouslyBusy: readonly string[];
    nameOf: (agentUid: string) => string;
    now: number;
    /** Bots whose reply already ended the row this turn (see
     *  {@link AnsweredWhileBusy}); their still-set `busy` is not re-shown. */
    answered?: AnsweredWhileBusy;
    /** Newest known message time from this bot in its DM, to pin the row
     *  (see {@link ThinkingEntry.afterMs}). Undefined when the app holds no
     *  timeline for that DM or the bot has no message in it: there is nothing
     *  to pin to, and the clock-skew rule is the only one left. */
    afterMsOf?: (agentUid: string) => number | undefined;
  },
): ThinkingByRow {
  let next = map;
  const busyNow = new Set(opts.busy);
  for (const uid of opts.previouslyBusy) {
    if (!busyNow.has(uid)) next = clearAgentEverywhere(next, uid);
  }
  for (const uid of opts.busy) {
    const rowId = `dm:${uid}`;
    if (next[rowId]?.some((e) => e.agentUid === uid)) continue;
    if (opts.answered?.[uid]) continue;
    const afterMs = opts.afterMsOf?.(uid);
    next = startThinkingIn(
      next,
      rowId,
      { agentUid: uid, agentName: opts.nameOf(uid) },
      opts.now,
      afterMs !== undefined ? { afterMs } : undefined,
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Why a row ended, for the app's file log.
//
// A walkthrough showed bot DM rows that vanished before the reply with no way
// to tell which path removed them. Every path that removes rows names its
// reason, and one log line per ended bot DM row records it: ids, the reason,
// how long the row had been up and whether it was pinned. No message text.

export type ThinkingEndReason =
  | 'newer-message'
  | 'expired'
  | 'status-silent'
  | 'send-failed'
  | 'tenant-switch'
  | 'verdict'
  | 'other';

/** Bot DM rows (`dm:<agentUid>` with an agent on it) present in `prev` and
 *  gone from `next`. A restart keeps the agent's row, so it is not an end. */
export function endedBotDmThinking(
  prev: ThinkingByRow,
  next: ThinkingByRow,
): Array<{ rowId: string; entry: ThinkingEntry }> {
  if (prev === next) return [];
  const out: Array<{ rowId: string; entry: ThinkingEntry }> = [];
  for (const [rowId, entries] of Object.entries(prev)) {
    if (!rowId.startsWith('dm:')) continue;
    const kept = new Set((next[rowId] ?? []).map((e) => e.agentUid));
    for (const entry of entries) {
      if (!isAgentUid(entry.agentUid) || kept.has(entry.agentUid)) continue;
      out.push({ rowId, entry });
    }
  }
  return out;
}

/**
 * One `bot-thinking` log line: `ended agent=… row=… reason=… elapsedMs=… pinned=yes|no`.
 *
 * A row whose bot reported statuses before the person last wrote, and none
 * since, ends with ` statusThisTurn=no` on the line. The person sees such a
 * row run out with nothing said; the log is where a walkthrough can tell a
 * bot that went quiet for a whole turn from one that never reports statuses.
 */
export function thinkingEndedLogLine(input: {
  rowId: string;
  entry: ThinkingEntry;
  reason: ThinkingEndReason;
  now: number;
  /** Narrower cause under `other` (e.g. `busy-ended`). */
  via?: string;
}): string {
  const { rowId, entry, reason, now, via } = input;
  const elapsedMs = Math.max(0, Math.round(now - (entry.since ?? entry.startedAt)));
  const pinned = entry.afterMs !== undefined ? 'yes' : 'no';
  const quietTurn = entry.statusSeen === true && entry.lastStatusAt === undefined ? ' statusThisTurn=no' : '';
  return `ended agent=${entry.agentUid} row=${rowId} reason=${reason}${via ? ` via=${via}` : ''} elapsedMs=${elapsedMs} pinned=${pinned}${quietTurn}`;
}

// ---------------------------------------------------------------------------
// The reply ends the row, at the moment it lands.
//
// A local bot's `busy` flag comes from the CLI listing, polled every few
// seconds, and the CLI's in-flight marker outlives the bot's post by a moment.
// Holding the row until `busy` dropped kept "X is working on it…" under the
// answer for a few more seconds. The reply is the newer event, so it ends the
// row immediately; a `busy` still reported for that same turn afterwards is
// stale and must not bring the row back. It comes back only on a genuinely
// newer signal: the person writes again (an explicit start), the agent reports
// a status newer than its reply (`applyAgentStatus`), or `busy` drops and
// rises again (a new turn).

/** Local bots (by agent uid) whose reply ended their DM row while their CLI
 *  `busy` flag was still set. Their `busy` is ignored until it drops or an
 *  explicit start supersedes it. */
export type AnsweredWhileBusy = Readonly<Record<string, true>>;

/**
 * `clearRowFromMessages`, plus: a bot that was `busy` when its reply ended its
 * own DM row is remembered in `answered`, so the next `syncBusyThinking` does
 * not restart the row from the same (stale) turn. Returns NEW objects when
 * anything changed, the same ones otherwise.
 */
export function clearRowOnReply(
  map: ThinkingByRow,
  answered: AnsweredWhileBusy,
  rowId: string,
  messages: ReadonlyArray<{ fromPersonUid?: string | null; createdAt?: string | null }>,
  busy: readonly string[],
): { map: ThinkingByRow; answered: AnsweredWhileBusy } {
  const before = map[rowId];
  if (!before || before.length === 0) return { map, answered };
  const nextMap = clearRowFromMessages(map, rowId, messages);
  const after = new Set((nextMap[rowId] ?? []).map((e) => e.agentUid));
  let nextAnswered: Record<string, true> | null = null;
  for (const entry of before) {
    if (after.has(entry.agentUid)) continue;
    if (rowId !== `dm:${entry.agentUid}` || !busy.includes(entry.agentUid)) continue;
    nextAnswered ??= { ...answered };
    nextAnswered[entry.agentUid] = true;
  }
  return { map: nextMap, answered: nextAnswered ?? answered };
}

/** Forget bots whose `busy` has dropped: that turn is over, and the next
 *  `busy` is a new turn. Same object when nothing changed. */
export function releaseAnswered(
  answered: AnsweredWhileBusy,
  busy: readonly string[],
): AnsweredWhileBusy {
  const keys = Object.keys(answered);
  if (keys.length === 0) return answered;
  const busyNow = new Set(busy);
  const kept = keys.filter((uid) => busyNow.has(uid));
  if (kept.length === keys.length) return answered;
  return Object.fromEntries(kept.map((uid) => [uid, true as const]));
}

/** An explicit start for `agentUid` (the person wrote to it again) supersedes
 *  the answered turn. Same object when nothing changed. */
export function forgetAnswered(
  answered: AnsweredWhileBusy,
  agentUid: string,
): AnsweredWhileBusy {
  const uid = agentUid.trim();
  if (!answered[uid]) return answered;
  const { [uid]: _gone, ...rest } = answered;
  return rest;
}

/**
 * The rows to draw for a conversation whose timeline is `messages`. A pinned
 * row (`afterMs`) whose agent already has a message newer than the pin is
 * hidden, so the indicator disappears in the same render that shows the
 * reply, whichever path appended it. Unpinned rows are left to the explicit
 * clear (`clearFromMessages`). Same array when nothing is hidden.
 */
export function visibleThinking(
  entries: ThinkingEntry[],
  messages: ReadonlyArray<{ fromPersonUid?: string | null; createdAt?: string | null }>,
): ThinkingEntry[] {
  if (entries.length === 0 || messages.length === 0) return entries;
  const shown = entries.filter((entry) => {
    if (entry.afterMs === undefined) return true;
    const newest = newestMessageAtFrom(messages, entry.agentUid);
    return newest === undefined || newest <= entry.afterMs;
  });
  return shown.length === entries.length ? entries : shown;
}
