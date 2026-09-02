/**
 * Live in-app agent-session store (Sessions page).
 *
 * The ONE place the `agent_session_*` Tauri command surface and the three
 * `agent-session:*` events are spoken on the frontend. Everything above it —
 * the page, the strip, the transcript, the composer — reads runes off this
 * module and calls its actions; nothing else invokes those commands.
 *
 * Correctness model (why the seq bookkeeping looks the way it does):
 *   - `agent_session_replay(sessionId, sinceSeq)` returns
 *     `{ seq, receivedAtMs, event }` entries with `seq >= sinceSeq`, plus the
 *     `nextSeq` to ask for next time. A full catch-up is `sinceSeq = 0`.
 *   - Live `agent-session:event` payloads carry the same seq. A payload whose
 *     seq is EXACTLY `nextSeq` appends; a lower seq is a duplicate and is
 *     dropped; a higher seq means we missed events (a dropped Tauri emit, a
 *     slow listener registration) and we re-replay from `nextSeq` rather than
 *     rendering a transcript with a hole in it.
 * That invariant is what lets the transcript be a pure fold of `events`.
 *
 * TIMESTAMPS. The backend stamps every buffered event with `receivedAtMs` and
 * ships the same instant on the live `agent-session:event` payload and in
 * `agent_session_replay`, so a reopened transcript is dated by when things
 * actually happened rather than by when it was reopened. The store keeps those
 * stamps parallel to `events`; `null` survives only as "unknown", which the
 * fold keeps out of the day-divider decision.
 *
 * USER TURNS — mirror first, then defer to the backend. `agent_session_send`
 * records a `userMessage` event, so the operator's own words DO come back from
 * a replay. But the bubble has to appear the instant Enter is pressed, before
 * any round trip, so the store still mirrors each send in `userTurnsById` —
 * which deliberately OUTLIVES `close()`, because the first send of a new
 * session is immediately followed by a route change and a page remount. The
 * moment a backend `userMessage` lands for a session, the mirror for that
 * session is dropped: the authoritative copy has arrived and rendering both
 * would double every bubble.
 *
 * The fold itself (`foldSessionEvents`) is pure and lives with the components;
 * this module memoizes it on a revision counter so a render that only reads
 * `transcript` does not refold on every access.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { safeUnlisten } from '../../lib/listener-registry';
import type {
  ImageAttachment,
  SessionCommand,
  SessionEvent,
} from '../../components/sessions/session-events';
import {
  emptyTranscript,
  foldSessionEvents,
  type CardResolution,
  type ChatBlock,
  type PendingCard,
  type TranscriptState,
  type UsageSummary,
  type UserTurn,
  type UserTurnMeta,
} from '../../components/sessions/transcript-adapter';
import type { SkillCatalog } from '../../components/sessions/slash-commands';
import type { ProjectEntry } from '../../components/sessions/startwork';
import type {
  ContextLoaders,
  MeetingEntry,
  ReferenceText,
  SignalEntry,
  VaultEntry,
} from '../../components/sessions/context-attachments';
import type {
  ShareToChannelRequest,
  ShareToChannelResult,
} from '../../components/sessions/share-channel';

// ---------------------------------------------------------------------------
// Command surface types — the TS half of `crates/hq-desktop-core/agent_session`
// ---------------------------------------------------------------------------

/** Coarse UI state of a session (Rust `SessionPhase`). */
export type SessionPhase = 'starting' | 'idle' | 'working' | 'needsYou' | 'ended';

/** Which agent CLI a session drives (Rust `SessionTool`). */
export type SessionTool = 'claude' | 'codex';

/** How tool-permission requests are handled (Rust `PermissionMode`). */
export type PermissionMode = 'prompt' | 'bypassAll';

/** Everything needed to launch (or resume) one session (Rust `SessionSpec`). */
export interface SessionSpec {
  /** Client-minted id; empty string asks the backend to mint one. */
  sessionId: string;
  tool: SessionTool;
  /** Ignored by the backend (it always runs from the HQ root) but part of the shape. */
  cwd: string;
  company: string | null;
  model: string | null;
  effort: string | null;
  /** Existing CLI session id to resume. */
  resume: string | null;
  permissionMode: PermissionMode;
}

/** The user's answer to one parked permission request (Rust `PermissionDecision`). */
export type PermissionDecision =
  | { kind: 'allowOnce' }
  | { kind: 'allowSession' }
  | { kind: 'allow'; updatedInput: unknown }
  | { kind: 'deny'; message: string };

/** One answered question (Rust `QuestionAnswer`). */
export interface QuestionAnswer {
  questionId: string;
  values: string[];
}

/**
 * The composer's model / effort pills, as the NEXT turn should use them
 * (Rust `TurnOverrides`).
 *
 * Absolute, not a patch: `null` is the user choosing the CLI's own default,
 * which has to be able to clear an earlier choice. Applying these never forks
 * the chat — only a company change does.
 */
export interface TurnOverrides {
  model: string | null;
  effort: string | null;
}

/** One session the app is driving (Rust `SessionSummary`). */
export interface SessionSummary {
  sessionId: string;
  tool: SessionTool;
  phase: SessionPhase;
  company: string | null;
  /** The model id the CLI resolved — NOT the catalog value the pill holds. */
  model: string | null;
  /** The model the operator asked for, which is what a pill compares against. */
  requestedModel: string | null;
  /** The reasoning effort the session is currently running with. */
  effort: string | null;
  /** How this session answers tool-permission requests. */
  permissionMode: PermissionMode;
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  lastSeq: number;
  pendingCount: number;
}

/** A company the preflight offers as a session binding. */
export interface PreflightCompany {
  slug: string;
  displayName: string;
}

/** Can this machine run an in-app session at all, and what is missing? */
export interface Preflight {
  hqRoot: string;
  hooksReady: boolean;
  hooksError: string | null;
  claudeAvailable: boolean;
  claudeLoggedIn: boolean;
  codexAvailable: boolean;
  /** The Codex CLI signs in separately from the ChatGPT desktop app. */
  codexLoggedIn: boolean;
  companies: PreflightCompany[];
}

/** The CLI's slash-command catalog + model list, for the composer's pills. */
export interface CommandCatalog {
  commands: SessionCommand[];
  /** Free-form JSON from the CLI handshake; read via `readSessionModels`. */
  models: unknown[];
}

/** What `agent_session_open_in_app` did (Rust `OpenInAppOutcome`). */
export interface OpenInAppOutcome {
  /** `terminal` today; `desktop` once a real resume deep link exists. */
  opened: 'terminal' | 'desktop';
  /** Human-readable description of what was launched. */
  detail: string;
}

/** `agent-session:event` payload. */
interface SessionEventPayload {
  sessionId: string;
  seq: number;
  /** Unix ms the backend recorded the event — the same stamp a replay returns. */
  receivedAtMs: number;
  event: SessionEvent;
}

/** One entry of an `agent_session_replay` page. */
interface ReplayEntry {
  seq: number;
  receivedAtMs: number;
  event: SessionEvent;
}

/** What `agent_session_replay` returns. */
interface ReplayPage {
  events: ReplayEntry[];
  nextSeq: number;
  truncated: boolean;
}

/** `agent-session:phase` payload. */
interface SessionPhasePayload {
  sessionId: string;
  from: SessionPhase;
  to: SessionPhase;
}

/** `agent-session:needs-you` payload. */
export interface NeedsYouNotice {
  sessionId: string;
  requestId: string;
  reason: 'permission' | 'question';
  summary: string;
}

export const AGENT_SESSION_EVENT = 'agent-session:event';
export const AGENT_SESSION_PHASE = 'agent-session:phase';
export const AGENT_SESSION_NEEDS_YOU = 'agent-session:needs-you';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Everything the store knows about ONE opened session. */
interface SessionEntry {
  sessionId: string;
  events: SessionEvent[];
  /**
   * Wall-clock ms each event was recorded by the backend, parallel to
   * `events`. `null` only where an instant is genuinely unknown — the fold
   * keeps those out of the day-divider decision (see the module header).
   */
  receivedAt: (number | null)[];
  /** The seq to pass as `sinceSeq` on the next replay. */
  nextSeq: number;
  phase: SessionPhase;
  /**
   * A live `agent-session:phase` event has landed for this session. Until it
   * does, the registry snapshot is the better answer than the `starting`
   * placeholder — after it does, the snapshot is the stale one.
   */
  phaseObserved: boolean;
  /** The buffer dropped events before our window — the transcript has a hole. */
  truncated: boolean;
  loading: boolean;
  error: string;
  /** requestId → the verb this client answered it with, so its card can retire. */
  resolutions: Record<string, CardResolution>;
}

function newEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    events: [],
    receivedAt: [],
    nextSeq: 0,
    phase: 'starting',
    phaseObserved: false,
    truncated: false,
    loading: true,
    error: '',
    resolutions: {},
  };
}

let entries = $state<Record<string, SessionEntry>>({});
let activeId = $state<string | null>(null);
let sessions = $state<SessionSummary[]>([]);
let listError = $state('');
let needsYou = $state<NeedsYouNotice | null>(null);
/** Bumped on every transcript-affecting mutation; the fold memo keys on it. */
let revision = $state(0);

/**
 * The operator's own turns, per session — the half of the transcript the
 * backend does not have. Deliberately module-level and NOT part of `entries`:
 * `close()` drops an entry, and the very first send is immediately followed by
 * a route change that closes and reopens the session. Keeping the mirror out
 * of the entry is what makes the sent message survive that remount.
 *
 * A plain object rather than `$state`: every mutation bumps `revision`, which
 * is what consumers are actually subscribed to.
 */
let userTurnsById: Record<string, UserTurn[]> = {};
/**
 * What each sent turn MEANT (hidden orientation turn, its label, its context
 * tags), keyed by session then by text. Outlives the mirror on purpose: the
 * backend's `userMessage` replaces the mirrored bubble, and without this the
 * `/startwork` divider would turn back into a raw bubble the moment it did.
 */
let turnMetaById: Record<string, Record<string, UserTurnMeta>> = {};
/**
 * The optimistic bubble for a send that is starting its own session — it has
 * nowhere to live until the backend mints an id.
 */
let draftTurns: UserTurn[] = [];
let turnSeq = 0;

let unlistenEvent: UnlistenFn | null = null;
let unlistenPhase: UnlistenFn | null = null;
let unlistenNeedsYou: UnlistenFn | null = null;
let listenersStarting = false;

let foldCache: { id: string; revision: number; value: TranscriptState } | null = null;

/** Fold-cache key for the pre-session optimistic bubble. */
const DRAFT_ID = '@draft';

const EMPTY_TRANSCRIPT: TranscriptState = emptyTranscript();

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

function applyEvent(
  sessionId: string,
  seq: number,
  receivedAtMs: number | undefined,
  event: SessionEvent,
): void {
  const entry = entries[sessionId];
  if (!entry) return; // Not a session this store has open — nothing to fold into.
  if (seq < entry.nextSeq) return; // Duplicate (a replay already covered it).
  if (seq > entry.nextSeq) {
    // A gap. Rendering the newer event would silently drop the missing span,
    // so catch up from the last contiguous seq instead.
    void replayFrom(sessionId, entry.nextSeq);
    return;
  }
  entry.events.push(event);
  // The backend's stamp is authoritative — it is the same instant a later
  // replay will report. `Date.now()` is only a fallback for a payload from an
  // older backend that carries none.
  entry.receivedAt.push(receivedAtMs ?? Date.now());
  entry.nextSeq = seq + 1;
  adoptBackendTurns(sessionId, [event]);
  revision += 1;
}

/**
 * The backend's own record of the operator's turns has arrived — drop the
 * local mirror for this session so the bubble is not rendered twice.
 *
 * The mirror exists only to paint a bubble before the round trip completes;
 * once a `userMessage` event is in the event log it is both authoritative and
 * correctly positioned, and the two would otherwise stack.
 */
function adoptBackendTurns(sessionId: string, incoming: ReadonlyArray<SessionEvent>): void {
  if (!incoming.some((event) => event.kind === 'userMessage')) return;
  if (!(sessionId in userTurnsById)) return;
  delete userTurnsById[sessionId];
  foldCache = null;
}

async function replayFrom(sessionId: string, sinceSeq: number): Promise<void> {
  const entry = entries[sessionId];
  if (!entry) return;
  try {
    const replay = await invoke<ReplayPage>('agent_session_replay', {
      sessionId,
      sinceSeq,
    });
    const target = entries[sessionId];
    if (!target) return;
    const incoming = replay.events.map((entry) => entry.event);
    // The backend stamped each event when it recorded it, so a replayed
    // transcript is dated by when it happened rather than by when it was
    // reopened. A page from an older backend carries no stamp; `null` keeps
    // those events out of the day-divider decision instead of filing a week of
    // history under today.
    const stamps = replay.events.map((entry) =>
      typeof entry.receivedAtMs === 'number' ? entry.receivedAtMs : null,
    );
    adoptBackendTurns(sessionId, incoming);
    // `sinceSeq === 0` is a full catch-up: replace. A partial replay fills a
    // gap from the last contiguous seq forward, so it appends onto what we
    // already folded.
    target.events = sinceSeq === 0 ? incoming : [...target.events, ...incoming];
    target.receivedAt =
      sinceSeq === 0 ? stamps : [...target.receivedAt, ...stamps];
    target.nextSeq = replay.nextSeq;
    target.truncated = target.truncated || replay.truncated;
    target.loading = false;
    target.error = '';
    revision += 1;
  } catch (err) {
    const target = entries[sessionId];
    if (!target) return;
    target.loading = false;
    target.error = errorText(err);
  }
}

async function ensureListeners(): Promise<void> {
  if (unlistenEvent || listenersStarting) return;
  listenersStarting = true;
  try {
    const [onEvent, onPhase, onNeeds] = await Promise.all([
      listen<SessionEventPayload>(AGENT_SESSION_EVENT, ({ payload }) => {
        applyEvent(payload.sessionId, payload.seq, payload.receivedAtMs, payload.event);
      }),
      listen<SessionPhasePayload>(AGENT_SESSION_PHASE, ({ payload }) => {
        const entry = entries[payload.sessionId];
        if (entry) {
          entry.phase = payload.to;
          entry.phaseObserved = true;
        }
        // The registry is the source of truth for the list; a phase change is
        // exactly when it moved.
        void refreshList();
      }),
      listen<NeedsYouNotice>(AGENT_SESSION_NEEDS_YOU, ({ payload }) => {
        needsYou = payload;
      }),
    ]);
    unlistenEvent = safeUnlisten(onEvent);
    unlistenPhase = safeUnlisten(onPhase);
    unlistenNeedsYou = safeUnlisten(onNeeds);
  } finally {
    listenersStarting = false;
  }
}

function teardownListeners(): void {
  unlistenEvent?.();
  unlistenPhase?.();
  unlistenNeedsYou?.();
  unlistenEvent = null;
  unlistenPhase = null;
  unlistenNeedsYou = null;
}

// ---------------------------------------------------------------------------
// The operator's own turns
// ---------------------------------------------------------------------------

function newTurn(text: string, atIndex: number, meta: UserTurnMeta = {}): UserTurn {
  turnSeq += 1;
  return { id: `t${turnSeq}`, text, atIndex, at: Date.now(), ...meta };
}

/** Keep a turn's meaning past the mirror, so the backend echo renders alike. */
function keepTurnMeta(sessionId: string, text: string, meta: UserTurnMeta): void {
  if (!meta.hidden && !meta.label && !(meta.attachments && meta.attachments.length > 0)) return;
  turnMetaById[sessionId] = { ...(turnMetaById[sessionId] ?? {}), [text]: meta };
}

/** Mirror a sent turn onto a session, at the event index it was sent from. */
function recordTurn(sessionId: string, text: string, meta: UserTurnMeta = {}): void {
  const entry = entries[sessionId];
  const turn = newTurn(text, entry ? entry.events.length : 0, meta);
  userTurnsById[sessionId] = [...(userTurnsById[sessionId] ?? []), turn];
  keepTurnMeta(sessionId, text, meta);
  foldCache = null;
  revision += 1;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Refresh the driven-session list from the registry. */
async function refreshList(): Promise<void> {
  try {
    sessions = await invoke<SessionSummary[]>('agent_session_list');
    listError = '';
    // Seed the phase of any session that has not seen a live phase event yet
    // (a just-opened one). A session that HAS is left alone: its event stream
    // is newer than this snapshot.
    for (const summary of sessions) {
      const entry = entries[summary.sessionId];
      if (entry && !entry.phaseObserved) entry.phase = summary.phase;
    }
  } catch (err) {
    listError = errorText(err);
  }
}

/**
 * Open a session: subscribe (before replaying, so no event can slip between
 * the catch-up and the live stream) then replay it in full.
 */
async function open(sessionId: string): Promise<void> {
  activeId = sessionId;
  if (!entries[sessionId]) entries[sessionId] = newEntry(sessionId);
  const known = sessions.find((s) => s.sessionId === sessionId);
  if (known) entries[sessionId]!.phase = known.phase;
  // Subscribe BEFORE replaying: an event emitted between the catch-up and the
  // subscription would otherwise be lost with no seq gap to reveal it.
  await ensureListeners();
  // The registry snapshot is fetched ALONGSIDE the replay rather than after
  // it. The first send is immediately followed by a route change that closes
  // and reopens the session, and the only phase this entry has until the list
  // lands is whatever the pre-send snapshot said — so every round trip spent
  // before that correction is a round trip the strip spends naming the wrong
  // state on a session that is mid-turn.
  await Promise.all([replayFrom(sessionId, 0), refreshList()]);
}

/**
 * Drop a session's buffered transcript; unlisten once nothing is open.
 *
 * The operator's mirrored turns are NOT dropped — see the module header: a
 * close/open pair is exactly what a route change does, and the message the
 * user just sent has to survive it.
 */
function close(sessionId: string): void {
  const { [sessionId]: _dropped, ...rest } = entries;
  entries = rest;
  if (activeId === sessionId) activeId = null;
  foldCache = null;
  revision += 1;
  if (Object.keys(entries).length === 0) teardownListeners();
}

/** Start a session and open it. Returns the backend-assigned session id. */
async function start(spec: SessionSpec): Promise<string> {
  const started = await invoke<{ sessionId: string }>('agent_session_start', { spec });
  await open(started.sessionId);
  return started.sessionId;
}

/**
 * The chat-first entry point: one message starts the session it belongs to.
 *
 * The bubble is mirrored BEFORE the backend is asked for anything, so the
 * operator sees their own words the instant they press Enter rather than after
 * a CLI handshake. When the id comes back the bubble is re-anchored onto the
 * real session, which is what carries it through the remount that the caller's
 * navigation triggers.
 */
async function startAndSend(
  spec: SessionSpec,
  text: string,
  images: ImageAttachment[] = [],
  meta: UserTurnMeta = {},
): Promise<string> {
  const optimistic = newTurn(text, 0, meta);
  draftTurns = [optimistic];
  foldCache = null;
  revision += 1;
  try {
    const sessionId = await start(spec);
    const entry = entries[sessionId];
    userTurnsById[sessionId] = [
      ...(userTurnsById[sessionId] ?? []),
      { ...optimistic, atIndex: entry ? entry.events.length : 0 },
    ];
    keepTurnMeta(sessionId, text, meta);
    draftTurns = [];
    foldCache = null;
    revision += 1;
    await invoke('agent_session_send', { sessionId, text, images, overrides: null });
    return sessionId;
  } catch (err) {
    // The send never happened, so the bubble would be a lie. Take it back.
    draftTurns = [];
    foldCache = null;
    revision += 1;
    throw err;
  }
}

/**
 * Send a user turn (or steer an in-flight one) to the active session.
 *
 * `overrides` carries the composer's model / effort pills when they have moved
 * since the session started. They are applied to the SAME session — changing a
 * model or a thinking effort must never start a new chat.
 */
async function send(
  text: string,
  images: ImageAttachment[] = [],
  overrides: TurnOverrides | null = null,
  meta: UserTurnMeta = {},
): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  recordTurn(sessionId, text, meta);
  await invoke('agent_session_send', { sessionId, text, images, overrides });
  if (overrides) await refreshList();
}

/**
 * Move the permission pill on a LIVE session. Claude is told over its control
 * channel and Codex rebinds its next turn's approval policy; either way the
 * session keeps running, so this is never a reason to fork the chat.
 */
async function setPermissionMode(mode: PermissionMode): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_set_permission_mode', { sessionId, mode });
  await refreshList();
}

/** Answer a parked permission request on the active session. */
async function respondPermission(
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_respond_permission', { sessionId, requestId, decision });
  markResolved(sessionId, requestId, permissionVerb(decision));
}

function permissionVerb(decision: PermissionDecision): CardResolution {
  switch (decision.kind) {
    case 'allowOnce':
      return 'Allowed';
    case 'allowSession':
      return 'Allowed for session';
    case 'allow':
      return 'Allowed';
    case 'deny':
      return 'Denied';
  }
}

/** Answer a parked `AskUserQuestion` on the active session. */
async function answerQuestion(
  requestId: string,
  answers: QuestionAnswer[],
): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_answer_question', { sessionId, requestId, answers });
  const chosen = answers.flatMap((answer) => answer.values).join(', ');
  markResolved(sessionId, requestId, chosen ? `Answered · ${chosen}` : 'Answered');
}

/**
 * Retire a card locally. The backend emits no event when a request is answered
 * (`LiveSession::on_response_sent` only drops it from the registry's pending
 * map), so the fold — which only ever sees the ORIGINAL request event — would
 * otherwise keep showing an answered card forever.
 */
function markResolved(
  sessionId: string,
  requestId: string,
  resolution: CardResolution,
): void {
  const entry = entries[sessionId];
  if (!entry || entry.resolutions[requestId]) return;
  entry.resolutions = { ...entry.resolutions, [requestId]: resolution };
  if (needsYou?.requestId === requestId) needsYou = null;
  revision += 1;
}

/** Stop the current turn without ending the session. */
async function interrupt(): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_interrupt', { sessionId });
}

/** End the active session (EOF, then a bounded wait, then a kill). */
async function end(): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_end', { sessionId });
  await refreshList();
}

/**
 * The id the CLI knows the active session by — what `--resume` / `resume`
 * take. Read off our own `started` event first (Claude's `system:init` id, or
 * Codex's thread id); when the event ring has dropped that event, ask the
 * registry, which latched the same value. A Claude session that has not
 * announced itself yet still resumes by the id the app minted for it.
 */
async function cliSessionIdOf(sessionId: string, tool: SessionTool): Promise<string> {
  const entry = entries[sessionId];
  for (const event of entry?.events ?? []) {
    if (event.kind === 'started' && event.sessionId) return event.sessionId;
  }
  const latched = await invoke<string | null>('agent_session_cli_session_id', { sessionId });
  if (latched) return latched;
  if (tool === 'claude') return sessionId;
  throw new Error('Codex has not announced its thread id yet — try again in a moment.');
}

/**
 * Reopen the active session in its native CLI surface (a Terminal running
 * `claude --resume` / `codex resume` in the HQ root). Thin: the backend owns
 * the allowlist, the id validation and the shell boundary.
 */
async function openInApp(): Promise<OpenInAppOutcome> {
  const sessionId = activeId;
  if (!sessionId) throw new Error('No live session to open.');
  const tool: SessionTool =
    sessions.find((s) => s.sessionId === sessionId)?.tool ?? startedToolOf(sessionId) ?? 'claude';
  const cliSessionId = await cliSessionIdOf(sessionId, tool);
  return invoke<OpenInAppOutcome>('agent_session_open_in_app', { tool, cliSessionId });
}

function startedToolOf(sessionId: string): SessionTool | null {
  for (const event of entries[sessionId]?.events ?? []) {
    if (event.kind === 'started') return event.tool === 'codex' ? 'codex' : 'claude';
  }
  return null;
}

/**
 * Post a session digest to a channel (creating it if asked) and invite
 * people. OUTWARD: this creates, invites and posts, so it is only ever called
 * from the share dialog's confirm click — never from an effect. The payload
 * is passed through exactly as built; the dialog and `share-channel.ts` own
 * its shape.
 */
function shareToChannel(request: ShareToChannelRequest): Promise<ShareToChannelResult> {
  return invoke<ShareToChannelResult>('session_share_to_channel', { ...request });
}

/**
 * Preflight and the catalog probe are expensive on the Rust side — the
 * preflight runs login-shell CLI probes with multi-second timeouts, and the
 * catalog probe spawns a real `claude` process that runs every HQ SessionStart
 * hook. The page remounts on every session navigation (it is keyed by session
 * id), so without memoization each first send paid for both again. Cache at
 * module scope: preflight for a short window, the catalog for the process
 * lifetime (the CLI's command list does not change while the app runs).
 */
const PREFLIGHT_TTL_MS = 60_000;
let preflightCache: { at: number; promise: Promise<Preflight> } | null = null;
let catalogCache: Map<SessionTool, Promise<CommandCatalog>> = new Map();

/** Can this machine run an in-app session, and what is missing if not? */
async function preflight(): Promise<Preflight> {
  const now = Date.now();
  if (preflightCache && now - preflightCache.at < PREFLIGHT_TTL_MS) {
    return preflightCache.promise;
  }
  const promise = invoke<Preflight>('agent_session_preflight');
  preflightCache = { at: now, promise };
  // A failed probe must not poison the cache for the next attempt.
  promise.catch(() => {
    if (preflightCache?.promise === promise) preflightCache = null;
  });
  return promise;
}

/** The CLI's slash-command catalog + model list. */
async function slashCommands(tool: SessionTool = 'claude'): Promise<CommandCatalog> {
  const cached = catalogCache.get(tool);
  if (cached) return cached;
  const promise = invoke<CommandCatalog>('agent_session_slash_commands', { tool });
  catalogCache.set(tool, promise);
  promise.catch(() => {
    if (catalogCache.get(tool) === promise) catalogCache.delete(tool);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// HQ-native context — the composer's slash picker, project submenu and `+` menu
// ---------------------------------------------------------------------------
//
// Thin `invoke` wrappers over `commands/hq_context.rs`, so the page keeps its
// "no raw invoke" contract. The skill catalog is the expensive one (it walks
// every `.claude/skills` dir and the worker registry) and is asked for on
// every `/`, so it is cached per company for the process lifetime; the rest
// are cheap directory reads asked for on a click.

let skillCatalogCache: Map<string, Promise<SkillCatalog>> = new Map();

/** Workers + skills the picker can offer, scoped to `company` when set. */
function hqSkillCatalog(company: string | null): Promise<SkillCatalog> {
  const key = company ?? '';
  const cached = skillCatalogCache.get(key);
  if (cached) return cached;
  const promise = invoke<SkillCatalog>('hq_skill_catalog', { company });
  skillCatalogCache.set(key, promise);
  promise.catch(() => {
    if (skillCatalogCache.get(key) === promise) skillCatalogCache.delete(key);
  });
  return promise;
}

/** A company's projects, newest `prd.json` first. */
function hqCompanyProjects(company: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>('hq_company_projects', { company });
}

function hqRecentMeetings(company: string, limit = 50): Promise<MeetingEntry[]> {
  return invoke<MeetingEntry[]>('hq_recent_meetings', { company, limit });
}

function hqSignals(company: string, kind: string | null = null, limit = 50): Promise<SignalEntry[]> {
  return invoke<SignalEntry[]>('hq_signals', { company, kind, limit });
}

function hqVaultFiles(
  company: string,
  prefix: string | null = null,
  query: string | null = null,
  limit = 200,
): Promise<VaultEntry[]> {
  return invoke<VaultEntry[]>('hq_vault_files', {
    company,
    prefix: prefix || null,
    query: query || null,
    limit,
  });
}

function hqReferenceText(path: string, maxChars = 6000): Promise<ReferenceText> {
  return invoke<ReferenceText>('hq_reference_text', { path, maxChars });
}

/** The loader set the composer's `+` menu takes. */
const contextLoaders: ContextLoaders = {
  meetings: (company) => hqRecentMeetings(company),
  signals: (company) => hqSignals(company),
  vaultFiles: (company, prefix, query) => hqVaultFiles(company, prefix, query),
  referenceText: (path, maxChars) => hqReferenceText(path, maxChars),
};

/** Test seam: forget memoized probes. */
export function resetProbeCaches(): void {
  preflightCache = null;
  catalogCache = new Map();
  skillCatalogCache = new Map();
}

/**
 * Reset every scrap of module state. Not used by the running app (the store is
 * a lifetime singleton) — exported so tests start from a known board.
 */
export function resetLiveSessionStore(): void {
  teardownListeners();
  entries = {};
  activeId = null;
  sessions = [];
  listError = '';
  needsYou = null;
  revision = 0;
  foldCache = null;
  userTurnsById = {};
  turnMetaById = {};
  draftTurns = [];
  turnSeq = 0;
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

function activeEntry(): SessionEntry | null {
  return activeId ? (entries[activeId] ?? null) : null;
}

function transcriptOf(entry: SessionEntry | null): TranscriptState {
  // Read the revision rune so every consumer stays subscribed to transcript
  // mutations even on a memo hit.
  const rev = revision;
  if (!entry) {
    // No session yet: the only thing there can be is the optimistic bubble of
    // a first send that has not been answered by the backend.
    if (draftTurns.length === 0) return EMPTY_TRANSCRIPT;
    // Memoized like a real session's fold — a getter that returned a fresh
    // object per read would re-run every `$derived` that touches it forever.
    if (foldCache && foldCache.id === DRAFT_ID && foldCache.revision === rev) {
      return foldCache.value;
    }
    const draft = foldSessionEvents([], { userTurns: draftTurns });
    foldCache = { id: DRAFT_ID, revision: rev, value: draft };
    return draft;
  }
  if (foldCache && foldCache.id === entry.sessionId && foldCache.revision === rev) {
    return foldCache.value;
  }
  const value = foldSessionEvents(entry.events, {
    receivedAt: entry.receivedAt,
    userTurns: userTurnsById[entry.sessionId] ?? [],
    resolutions: entry.resolutions,
    turnMeta: turnMetaById[entry.sessionId],
  });
  foldCache = { id: entry.sessionId, revision: rev, value };
  return value;
}

export const liveSessionStore = {
  /** Every session the app is driving, newest state from the registry. */
  get sessions(): SessionSummary[] {
    return sessions;
  },
  get listError(): string {
    return listError;
  },
  get activeSessionId(): string | null {
    return activeId;
  },
  get phase(): SessionPhase {
    return activeEntry()?.phase ?? 'idle';
  },
  get loading(): boolean {
    return activeEntry()?.loading ?? false;
  },
  get error(): string {
    return activeEntry()?.error ?? '';
  },
  get truncated(): boolean {
    return activeEntry()?.truncated ?? false;
  },
  /** Raw event log of the active session (oldest first). */
  get events(): SessionEvent[] {
    return activeEntry()?.events ?? [];
  },
  /** Backend record-time stamps parallel to `events`; `null` when unknown. */
  get receivedAt(): (number | null)[] {
    return activeEntry()?.receivedAt ?? [];
  },
  /** The seq to ask for on the next replay of the active session. */
  get nextSeq(): number {
    return activeEntry()?.nextSeq ?? 0;
  },
  /** Folded transcript of the active session. */
  get transcript(): TranscriptState {
    return transcriptOf(activeEntry());
  },
  /** The chat blocks the transcript renders, oldest first. */
  get blocks(): ChatBlock[] {
    return transcriptOf(activeEntry()).blocks;
  },
  /** Cards the active session is blocked on, in arrival order. */
  get pending(): PendingCard[] {
    return transcriptOf(activeEntry()).pending;
  },
  /** The last turn's token/cost summary, for the composer footer. */
  get lastUsage(): UsageSummary | null {
    return transcriptOf(activeEntry()).lastUsage;
  },
  /** The operator's mirrored turns on the active session. */
  get userTurns(): UserTurn[] {
    const entry = activeEntry();
    void revision;
    if (!entry) return draftTurns;
    return userTurnsById[entry.sessionId] ?? [];
  },
  /** The latest "this session is blocked on you" notice, or null. */
  get needsYou(): NeedsYouNotice | null {
    return needsYou;
  },
  /** Slash-command names the CLI announced when the active session started. */
  get startedCommands(): SessionCommand[] {
    const entry = activeEntry();
    if (!entry) return [];
    for (const event of entry.events) {
      if (event.kind === 'started') return event.commands;
    }
    return [];
  },
  /** The model id the CLI reported for the active session, when it said one. */
  get startedModel(): string | null {
    const entry = activeEntry();
    if (!entry) return null;
    for (const event of entry.events) {
      if (event.kind === 'started' && event.model) return event.model;
    }
    return null;
  },
  /** The active session's registry summary, when the list knows about it. */
  get summary(): SessionSummary | null {
    return sessions.find((s) => s.sessionId === activeId) ?? null;
  },
  open,
  close,
  refreshList,
  start,
  startAndSend,
  send,
  setPermissionMode,
  respondPermission,
  answerQuestion,
  interrupt,
  end,
  openInApp,
  shareToChannel,
  preflight,
  slashCommands,
  hqSkillCatalog,
  hqCompanyProjects,
  hqRecentMeetings,
  hqSignals,
  hqVaultFiles,
  hqReferenceText,
  contextLoaders,
};
