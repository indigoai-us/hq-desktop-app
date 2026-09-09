import { missingInheritedPrefix, type SessionContext } from './session-context';
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
 *
 * THE FOLD NEVER TAKES THE PAGE DOWN. The fold guards every event and reports
 * what it could not show in `foldErrors`; `safeFold` here guards the fold
 * itself (a transcript that says "could not be displayed" beats a blank
 * window) and writes those errors to the console once per session, not once
 * per render.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { WEB_PATHS, skillMetadataFromShelf, type ShelfSkillMetadata } from '@hq/platform';
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
import type { ProjectEntry, ProjectViewer } from '../../components/sessions/startwork';
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
import type { AgentSession } from './sessions';

// ---------------------------------------------------------------------------
// Command surface types — the TS half of `crates/hq-desktop-core/agent_session`
// ---------------------------------------------------------------------------

/** Coarse UI state of a session (Rust `SessionPhase`). */
export type SessionPhase = 'starting' | 'idle' | 'working' | 'needsYou' | 'ended';

/** Which agent CLI a session drives (Rust `SessionTool`). */
export type SessionTool = 'claude' | 'codex' | 'grok';

/** How tool-permission requests are handled (Rust `PermissionMode`). */
export type PermissionMode = 'prompt' | 'bypassAll';

/** Everything needed to launch (or resume) one session (Rust `SessionSpec`). */
export interface SessionSpec {
  projectChannelId?: string;
  /** Client-minted id; empty string asks the backend to mint one. */
  sessionId: string;
  /** Native provider title retained when this wraps a resumed conversation. */
  title?: string | null;
  tool: SessionTool;
  /** Ignored by the backend (it always runs from the HQ root) but part of the shape. */
  cwd: string;
  company: string | null;
  /**
   * The company project the session works on — its directory slug, the key
   * its channel (`p-<slug>`) is named from. Optional on the wire (Rust
   * `#[serde(default)]`) so callers that never bind a project send nothing.
   */
  project?: string | null;
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
  /** Durable provider ID from the native session handshake. */
  cliSessionId?: string | null;
  /** Concise title derived from the first visible operator prompt. */
  title?: string;
  tool: SessionTool;
  phase: SessionPhase;
  company: string | null;
  /** The bound project (directory slug), from the composer or from HQ creating one mid-session. */
  project?: string | null;
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
  /** Provider-native id this app-owned row resumed from. */
  resumedFrom?: string | null;
  /** Exclusive provider transcript cursor for the next older page. */
  historyBefore?: number | null;
}

/** A company the preflight offers as a session binding. */
export interface PreflightCompany {
  slug: string;
  displayName: string;
  cloudUid?: string | null;
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
  grokAvailable: boolean;
  /** The Grok CLI signs in separately from grok.com in the browser. */
  grokLoggedIn: boolean;
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

interface DurableHistoryPage {
  events: Array<{ receivedAtMs: number; event: SessionEvent }>;
  before: number | null;
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
  /** Provider metadata when this is a hydrated, dormant conversation. */
  history: AgentSession | null;
  context: SessionContext | null;
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
  historyBefore: number | null;
  historyCursorReady: boolean;
  loadingEarlier: boolean;
  loading: boolean;
  error: string;
  /** requestId → the verb this client answered it with, so its card can retire. */
  resolutions: Record<string, CardResolution>;
}

function newEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    history: null,
    context: null,
    events: [],
    receivedAt: [],
    nextSeq: 0,
    phase: 'starting',
    phaseObserved: false,
    truncated: false,
    historyBefore: null,
    historyCursorReady: false,
    loadingEarlier: false,
    loading: true,
    error: '',
    resolutions: {},
  };
}

let entries = $state<Record<string, SessionEntry>>({});
let activeId = $state<string | null>(null);
let sessions = $state<SessionSummary[]>([]);
let listError = $state('');
let sharingErrors = $state<Record<string, string | null>>({});
let needsYou = $state<NeedsYouNotice | null>(null);
/** Bumped on every transcript-affecting mutation; the fold memo keys on it. */
let revision = $state(0);

interface HistoricalConversation {
  session: AgentSession;
  events: SessionEvent[];
  receivedAt: (number | null)[];
  before: number | null;
}

/**
 * Hydrated provider transcripts survive the route remount caused by selecting
 * a row. They are read-only until the first new send creates a live runtime.
 */
let historicalConversationsById: Record<string, HistoricalConversation> = {};

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
let unlistenSharing: UnlistenFn | null = null;
let listenersStarting = false;

let foldCache: { id: string; revision: number; value: TranscriptState } | null = null;
/** Sessions whose fold errors have already been written to the console. */
let foldErrorsReported = new Set<string>();

type TurnDoneEvent = Extract<SessionEvent, { kind: 'turnDone' }>;
interface TurnWaiter {
  afterIndex: number;
  resolve: (event: TurnDoneEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
let turnWaiters = new Map<string, Set<TurnWaiter>>();

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
  resolveTurnWaiters(sessionId);
  revision += 1;
}

function resolveTurnWaiters(sessionId: string): void {
  const entry = entries[sessionId];
  const waiters = turnWaiters.get(sessionId);
  if (!entry || !waiters) return;
  for (const waiter of [...waiters]) {
    const completed = entry.events
      .slice(waiter.afterIndex)
      .find((event): event is TurnDoneEvent => event.kind === 'turnDone');
    if (!completed) continue;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    waiter.resolve(completed);
  }
  if (waiters.size === 0) turnWaiters.delete(sessionId);
}

/** Wait for the turn started after `afterIndex` to finish; used to sequence orientation. */
function waitForTurnDone(
  sessionId: string,
  afterIndex = 0,
  timeoutMs = 180_000,
): Promise<TurnDoneEvent> {
  const entry = entries[sessionId];
  if (!entry) return Promise.reject(new Error('Session is not open.'));
  const completed = entry.events
    .slice(afterIndex)
    .find((event): event is TurnDoneEvent => event.kind === 'turnDone');
  if (completed) return Promise.resolve(completed);

  return new Promise((resolve, reject) => {
    const waiter = {} as TurnWaiter;
    waiter.afterIndex = afterIndex;
    waiter.resolve = resolve;
    waiter.reject = reject;
    waiter.timer = setTimeout(() => {
      const waiters = turnWaiters.get(sessionId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) turnWaiters.delete(sessionId);
      reject(new Error('Session context took too long to load.'));
    }, timeoutMs);
    const waiters = turnWaiters.get(sessionId) ?? new Set<TurnWaiter>();
    waiters.add(waiter);
    turnWaiters.set(sessionId, waiters);
    // Close the event-between-check-and-register race.
    resolveTurnWaiters(sessionId);
  });
}

/**
 * The backend's own record of the operator's turns has arrived — drop the
 * matching local mirrors so their bubbles are not rendered twice.
 *
 * The mirror exists only to paint a bubble before the round trip completes;
 * once a `userMessage` event is in the event log it is both authoritative and
 * correctly positioned, and the two would otherwise stack. Match one mirror
 * per echo instead of clearing the whole queue: the first real prompt may
 * already be visible while the hidden orientation turn is still finishing.
 */
function adoptBackendTurns(sessionId: string, incoming: ReadonlyArray<SessionEvent>): void {
  const echoed = incoming
    .filter((event): event is Extract<SessionEvent, { kind: 'userMessage' }> =>
      event.kind === 'userMessage',
    )
    .map((event) => event.text);
  const turns = userTurnsById[sessionId];
  if (echoed.length === 0 || !turns) return;

  const remaining = [...turns];
  for (const text of echoed) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    let index = remaining.findIndex(
      (turn) => turn.text.replace(/\r\n/g, '\n').trim() === normalized,
    );
    // A fresh session has one optimistic first turn. If the provider rewrote
    // its whitespace, it is still the authoritative echo of that turn.
    if (index < 0 && echoed.length === 1 && remaining.length === 1) index = 0;
    if (index < 0) continue;
    const [adopted] = remaining.splice(index, 1);
    if (adopted) keepTurnMeta(sessionId, text, adopted);
  }
  if (remaining.length > 0) userTurnsById[sessionId] = remaining;
  else delete userTurnsById[sessionId];
  foldCache = null;
  revision += 1;
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
    resolveTurnWaiters(sessionId);
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
    const [onEvent, onPhase, onNeeds, onSharing] = await Promise.all([
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
      listen<{ sessionId: string; error: string | null }>('project-session:sharing-status', ({ payload }) => {
        sharingErrors = { ...sharingErrors, [payload.sessionId]: payload.error };
      }),
    ]);
    unlistenEvent = safeUnlisten(onEvent);
    unlistenPhase = safeUnlisten(onPhase);
    unlistenNeedsYou = safeUnlisten(onNeeds);
    unlistenSharing = safeUnlisten(onSharing);
  } finally {
    listenersStarting = false;
  }
}

function teardownListeners(): void {
  unlistenEvent?.();
  unlistenPhase?.();
  unlistenNeedsYou?.();
  unlistenSharing?.();
  unlistenEvent = null;
  unlistenPhase = null;
  unlistenNeedsYou = null;
  unlistenSharing = null;
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
  if (
    !meta.hidden &&
    !meta.label &&
    !meta.contextLabel &&
    !meta.displayText &&
    !(meta.attachments && meta.attachments.length > 0)
  ) return;
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
      if (entry && !entry.historyCursorReady) {
        entry.historyBefore = summary.historyBefore ?? null;
        entry.historyCursorReady = true;
      }
    }
  } catch (err) {
    listError = errorText(err);
  }
}

async function loadContext(sessionId: string): Promise<void> {
  try {
    const context = await invoke<SessionContext>('agent_session_context', { sessionId });
    if (entries[sessionId]) { entries[sessionId].context = context ?? null; revision += 1; }
  } catch { /* Older native builds have no provenance command. */ }
}

/**
 * Open a session: subscribe (before replaying, so no event can slip between
 * the catch-up and the live stream) then replay it in full.
 */
async function open(sessionId: string): Promise<void> {
  activeId = sessionId;
  const historical = historicalConversationsById[sessionId];
  if (historical && !sessions.some((session) => session.sessionId === sessionId)) {
    const entry = newEntry(sessionId);
    entry.history = historical.session;
    entry.events = [...historical.events];
    entry.receivedAt = [...historical.receivedAt];
    entry.phase = 'idle';
    entry.loading = false;
    entry.historyBefore = historical.before;
    entry.historyCursorReady = true;
    entries[sessionId] = entry;
    foldCache = null;
    revision += 1;
    await loadContext(sessionId);
    return;
  }
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
  await Promise.all([replayFrom(sessionId, 0), refreshList(), loadContext(sessionId)]);
}

/** Open a provider transcript without spawning or resuming its CLI process. */
async function openHistory(session: AgentSession): Promise<void> {
  activeId = session.id;
  const cached = historicalConversationsById[session.id];
  if (cached) {
    await open(session.id);
    return;
  }

  const entry = newEntry(session.id);
  entry.history = session;
  entry.phase = 'idle';
  entries[session.id] = entry;
  foldCache = null;
  revision += 1;
  try {
    await loadContext(session.id);
    const page = await invoke<DurableHistoryPage>('agent_session_history_page', {
      sessionId: session.id,
      before: null,
      tool: session.tool,
    });
    const target = entries[session.id];
    if (!target) return;
    target.events = page.events.map((item) => item.event);
    target.receivedAt = page.events.map((item) => item.receivedAtMs ?? null);
    target.historyBefore = page.before;
    target.historyCursorReady = true;
    target.loading = false;
    target.error = '';
    historicalConversationsById[session.id] = {
      session,
      events: [...target.events],
      receivedAt: [...target.receivedAt],
      before: target.historyBefore,
    };
    revision += 1;
  } catch (err) {
    const target = entries[session.id];
    if (!target) return;
    target.loading = false;
    target.error = errorText(err);
  }
}

function sameDialogueEvent(left: SessionEvent | undefined, right: SessionEvent | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'userMessage' && right.kind === 'userMessage') return left.text === right.text;
  if (left.kind === 'assistantMessage' && right.kind === 'assistantMessage') return left.text === right.text;
  return false;
}

/** Prepend one bounded page from the provider transcript without disturbing
 * the live replay sequence. The caller preserves the reader's scroll anchor. */
async function loadEarlier(): Promise<void> {
  const sessionId = activeId;
  const entry = activeEntry();
  if (!sessionId || !entry || entry.loadingEarlier) return;
  const inherited = entry.context;
  const loadInherited = Boolean(inherited?.sourceSessionId && inherited.history.before != null
    && (entry.historyBefore === null || missingInheritedPrefix(inherited, entry.events, entry.receivedAt).length > 0));
  if (!loadInherited && entry.historyBefore === null) return;
  entry.loadingEarlier = true;
  entry.error = '';
  try {
    const page = await invoke<DurableHistoryPage>('agent_session_history_page', {
      sessionId: loadInherited ? inherited!.sourceSessionId : sessionId,
      before: loadInherited ? inherited!.history.before : entry.historyBefore,
      ...(loadInherited ? { tool: entry.history?.tool ?? sessions.find(item => item.sessionId === sessionId)?.tool } : entry.history ? { tool: entry.history.tool } : {}),
    });
    const target = entries[sessionId];
    if (!target) return;
    if (loadInherited && target.context) {
      target.context = { ...target.context, history: { events: [...page.events, ...target.context.history.events], before: page.before } };
      target.loadingEarlier = false;
      revision += 1;
      return;
    }
    const olderEvents = page.events.map((item) => item.event);
    const olderStamps = page.events.map((item) => item.receivedAtMs ?? null);
    if (sameDialogueEvent(olderEvents.at(-1), target.events[0])) {
      olderEvents.pop();
      olderStamps.pop();
    }
    target.events = [...olderEvents, ...target.events];
    target.receivedAt = [...olderStamps, ...target.receivedAt];
    target.historyBefore = page.before;
    target.historyCursorReady = true;
    target.loadingEarlier = false;
    if (target.history) {
      historicalConversationsById[sessionId] = {
        session: target.history,
        events: [...target.events],
        receivedAt: [...target.receivedAt],
        before: target.historyBefore,
      };
    }
    revision += 1;
  } catch (err) {
    const target = entries[sessionId];
    if (!target) return;
    target.loadingEarlier = false;
    target.error = errorText(err);
  }
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
  await ensureListeners();
  const started = await invoke<{ sessionId: string }>('agent_session_start', { spec, ...(spec.projectChannelId ? { projectChannelId: spec.projectChannelId } : {}) });
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
    // A fresh session has no history to replay. Subscribe as soon as the
    // backend mints its id, then write the first message before registry/list
    // housekeeping; waiting for `open()` here delayed real sends by 30+ sec.
    await ensureListeners();
    const started = await invoke<{ sessionId: string }>('agent_session_start', { spec, ...(spec.projectChannelId ? { projectChannelId: spec.projectChannelId } : {}) });
    const sessionId = started.sessionId;
    activeId = sessionId;
    if (!entries[sessionId]) entries[sessionId] = newEntry(sessionId);
    await ensureListeners();
    const entry = entries[sessionId]!;
    entry.loading = false;
    userTurnsById[sessionId] = [
      ...(userTurnsById[sessionId] ?? []),
      { ...optimistic, atIndex: entry.events.length },
    ];
    keepTurnMeta(sessionId, text, meta);
    draftTurns = [];
    foldCache = null;
    revision += 1;
    await invoke('agent_session_send', { sessionId, text, images, overrides: null });
    void refreshList();
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
 * Continue a dormant provider conversation. Opening history is read-only;
 * this first new turn is the precise point where a live runtime is needed.
 */
async function resumeAndSend(
  text: string,
  images: ImageAttachment[] = [],
  permissionMode: PermissionMode = 'prompt',
  meta: UserTurnMeta = {},
): Promise<string> {
  const dormantId = activeId;
  const dormant = activeEntry()?.history;
  if (!dormantId || !dormant) throw new Error('No historical session is open.');

  const optimistic = newTurn(text, activeEntry()?.events.length ?? 0, meta);
  userTurnsById[dormantId] = [...(userTurnsById[dormantId] ?? []), optimistic];
  keepTurnMeta(dormantId, text, meta);
  foldCache = null;
  revision += 1;

  try {
    const started = await invoke<{ sessionId: string }>('agent_session_start', {
      spec: {
        sessionId: '',
        title: dormant.title || null,
        tool: dormant.tool,
        cwd: dormant.cwd,
        company: dormant.company || null,
        project: dormant.project || null,
        model: null,
        effort: null,
        resume: dormant.id,
        permissionMode,
      } satisfies SessionSpec,
    });
    const sessionId = started.sessionId;
    activeId = sessionId;
    if (!entries[sessionId]) entries[sessionId] = newEntry(sessionId);
    await ensureListeners();
    await Promise.all([replayFrom(sessionId, 0), refreshList(), loadContext(sessionId)]);

    const entry = entries[sessionId]!;
    userTurnsById[sessionId] = [
      ...(userTurnsById[sessionId] ?? []),
      { ...optimistic, atIndex: entry.events.length },
    ];
    keepTurnMeta(sessionId, text, meta);
    delete userTurnsById[dormantId];
    foldCache = null;
    revision += 1;
    await invoke('agent_session_send', {
      sessionId,
      text,
      images,
      overrides: null,
    });
    void refreshList();
    return sessionId;
  } catch (err) {
    const remaining = (userTurnsById[dormantId] ?? []).filter(
      (turn) => turn.id !== optimistic.id,
    );
    if (remaining.length > 0) userTurnsById[dormantId] = remaining;
    else delete userTurnsById[dormantId];
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
  throw new Error(
    tool === 'grok'
      ? 'Grok has not announced its session id yet — try again in a moment.'
      : 'Codex has not announced its thread id yet — try again in a moment.',
  );
}

/**
 * Reopen the active session in its native CLI surface (a Terminal running
 * `claude --resume` / `codex resume` in the HQ root). Thin: the backend owns
 * the allowlist, the id validation and the shell boundary.
 */
async function openInApp(): Promise<OpenInAppOutcome> {
  const sessionId = activeId;
  if (!sessionId) throw new Error('No live session to open.');
  const historical = entries[sessionId]?.history;
  if (historical) {
    return invoke<OpenInAppOutcome>('agent_session_open_in_app', {
      tool: historical.tool,
      cliSessionId: historical.id,
    });
  }
  const tool: SessionTool =
    sessions.find((s) => s.sessionId === sessionId)?.tool ?? startedToolOf(sessionId) ?? 'claude';
  const cliSessionId = await cliSessionIdOf(sessionId, tool);
  return invoke<OpenInAppOutcome>('agent_session_open_in_app', { tool, cliSessionId });
}

function startedToolOf(sessionId: string): SessionTool | null {
  for (const event of entries[sessionId]?.events ?? []) {
    if (event.kind === 'started') {
      if (event.tool === 'codex' || event.tool === 'grok' || event.tool === 'claude') return event.tool;
    }
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
  // Native command signature is session_share_to_channel(args: ShareArgs).
  return invoke<ShareToChannelResult>('session_share_to_channel', { args: request });
}

/**
 * Preflight and the catalog probe are expensive on the Rust side — the
 * preflight runs login-shell CLI probes with multi-second timeouts, and the
 * catalog probe spawns a real `claude` process that runs every HQ SessionStart
 * hook. The page remounts on every session navigation (it is keyed by session
 * id), so without memoization each first send paid for both again. Cache at
 * module scope with bounded freshness. Providers can introduce models while
 * the app runs, and an empty probe must never pin fallback options in place.
 */
const PREFLIGHT_TTL_MS = 60_000;
export interface ProviderLoginState {
  state: 'disconnected' | 'waiting' | 'connected' | 'error';
  message?: string;
}
let preflightCache: { at: number; promise: Promise<Preflight> } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;
let catalogCache = new Map<SessionTool, { at: number; promise: Promise<CommandCatalog> }>();

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
async function slashCommands(tool: SessionTool = 'claude', refresh = false): Promise<CommandCatalog> {
  const cached = catalogCache.get(tool);
  if (!refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.promise;
  const promise = invoke<CommandCatalog>('agent_session_slash_commands', { tool });
  catalogCache.set(tool, { at: Date.now(), promise });
  const evict = () => {
    if (catalogCache.get(tool)?.promise === promise) catalogCache.delete(tool);
  };
  void promise.then((catalog) => {
    if (!catalog.models.length) evict();
  }, evict);
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
let skillMetadataCache: Map<string, Promise<ShelfSkillMetadata[]>> = new Map();

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

/** Cloud-only group/tag enrichment. Failure is intentionally separate from the local catalog. */
function hqSkillMetadata(companyUid: string): Promise<ShelfSkillMetadata[]> {
  const cached = skillMetadataCache.get(companyUid);
  if (cached) return cached;
  const promise = invoke<{ status: number; body: string }>('hq_pro_fetch', {
    url: WEB_PATHS.skillsShelf(companyUid), method: 'GET', body: null,
  }).then((response) => {
    if (response.status < 200 || response.status >= 300) throw new Error(`Skill groups unavailable (${response.status})`);
    return skillMetadataFromShelf(JSON.parse(response.body || '{}'));
  });
  skillMetadataCache.set(companyUid, promise);
  promise.catch(() => { if (skillMetadataCache.get(companyUid) === promise) skillMetadataCache.delete(companyUid); });
  return promise;
}

/** A company's projects, most recent activity first, archived ones flagged. */
function hqCompanyProjects(company: string): Promise<ProjectEntry[]> {
  return invoke<ProjectEntry[]>('hq_company_projects', { company });
}

let selfCache: Promise<ProjectViewer | null> | null = null;

/**
 * Who is signed in, for the project picker's "Mine" chip: the email off the
 * local Cognito claims (`get_auth_state` decodes the stored token — no
 * network). Null when signed out; a failure is null too, never an error, so
 * the picker still opens with the plain owner chips.
 */
function hqSelf(): Promise<ProjectViewer | null> {
  if (selfCache) return selfCache;
  const promise = invoke<{ authenticated?: boolean; email?: string | null }>('get_auth_state')
    .then((state) => {
      const email = state?.authenticated ? (state.email?.trim() ?? '') : '';
      return email ? { email } : null;
    })
    .catch(() => null);
  selfCache = promise;
  return promise;
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
  sharingErrors = {};
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
  foldErrorsReported = new Set();
  historicalConversationsById = {};
  for (const waiters of turnWaiters.values()) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Session store reset.'));
    }
  }
  turnWaiters = new Map();
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

/** What the transcript shows when the fold itself could not run. */
const FOLD_FAILED_TEXT = 'This conversation could not be displayed.';

/**
 * `foldSessionEvents`, guaranteed to return. The fold catches per event; this
 * catches the fold, so a session with a payload nobody anticipated renders a
 * one-line transcript instead of throwing through a `$derived` into the
 * shell's error boundary. Fold errors reach the console once per session.
 */
function safeFold(
  sessionId: string,
  events: ReadonlyArray<SessionEvent>,
  options: Parameters<typeof foldSessionEvents>[1],
): TranscriptState {
  let value: TranscriptState;
  try {
    value = foldSessionEvents(events, options);
  } catch (err) {
    console.error(`[live-session-store] transcript fold failed for ${sessionId}`, err);
    value = {
      ...emptyTranscript(),
      blocks: [{ type: 'error', id: 'fold-failed', tone: 'error', text: FOLD_FAILED_TEXT, at: null }],
      foldErrors: [{ index: -1, kind: 'fold', error: errorText(err) }],
    };
  }
  if (value.foldErrors.length > 0 && !foldErrorsReported.has(sessionId)) {
    foldErrorsReported.add(sessionId);
    console.warn(
      `[live-session-store] ${value.foldErrors.length} event(s) in session ${sessionId} could not be displayed`,
      value.foldErrors,
    );
  }
  return value;
}

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
    const draft = safeFold(DRAFT_ID, [], { userTurns: draftTurns });
    foldCache = { id: DRAFT_ID, revision: rev, value: draft };
    return draft;
  }
  if (foldCache && foldCache.id === entry.sessionId && foldCache.revision === rev) {
    return foldCache.value;
  }
  const prefix = missingInheritedPrefix(entry.context, entry.events, entry.receivedAt);
  const value = safeFold(entry.sessionId, [...prefix.map(item => item.event), ...entry.events], {
    receivedAt: [...prefix.map(item => item.receivedAtMs), ...entry.receivedAt],
    userTurns: (userTurnsById[entry.sessionId] ?? []).map(turn => ({ ...turn, atIndex: turn.atIndex + prefix.length })),
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
  get sharingNotice(): string {
    const id = activeId;
    if (!id || !(id in sharingErrors)) return '';
    return sharingErrors[id]
      ? 'Project sharing paused. Your session is saved locally; HQ will retry automatically.'
      : 'Shared read only with project chat members.';
  },
  get truncated(): boolean {
    return activeEntry()?.truncated ?? false;
  },
  get hasEarlier(): boolean {
    return activeEntry()?.historyBefore != null || activeEntry()?.context?.history.before != null;
  },
  get loadingEarlier(): boolean {
    return activeEntry()?.loadingEarlier ?? false;
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
      // `commands` is a Rust `Vec`, but the wire is read defensively throughout.
      if (event.kind === 'started') return Array.isArray(event.commands) ? event.commands : [];
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
    const live = sessions.find((s) => s.sessionId === activeId);
    if (live) return live;
    const entry = activeEntry();
    const historical = entry?.history;
    if (!entry || !historical) return null;
    return {
      sessionId: historical.id,
      title: historical.title || historical.project || 'Untitled session',
      tool: historical.tool,
      phase: 'idle',
      company: historical.company || null,
      project: historical.project || null,
      model: historical.model || null,
      requestedModel: null,
      effort: null,
      permissionMode: 'prompt',
      cwd: historical.cwd,
      startedAt: historical.startedAt,
      lastActivityAt: historical.lastActivityAt,
      lastSeq: entry.nextSeq,
      pendingCount: 0,
      resumedFrom: null,
      historyBefore: entry.historyBefore,
    };
  },
  get context(): SessionContext | null { return activeEntry()?.context ?? null; },
  get isHistorical(): boolean {
    return activeEntry()?.history !== null && activeEntry()?.history !== undefined;
  },
  open,
  openHistory,
  close,
  refreshList,
  loadEarlier,
  start,
  startAndSend,
  resumeAndSend,
  waitForTurnDone,
  send,
  setPermissionMode,
  respondPermission,
  answerQuestion,
  interrupt,
  end,
  openInApp,
  shareToChannel,
  preflight,
  providerLoginStart: (tool: SessionTool) => invoke<ProviderLoginState>('agent_provider_login_start', { tool }),
  providerLoginStatus: (tool: SessionTool) => invoke<ProviderLoginState>('agent_provider_login_status', { tool }),
  providerLoginCancel: (tool: SessionTool) => invoke<ProviderLoginState>('agent_provider_login_cancel', { tool }),
  invalidatePreflight: () => { preflightCache = null; },
  /** Install a sessions CLI in-app (npm, Node first if needed). Streams `install:progress`. */
  installProvider: async (tool: SessionTool, onLine?: (line: string) => void) => {
    const unlisten = await listen<{ line?: string }>('install:progress', (event) => {
      const line = event.payload?.line?.trim();
      if (line) onLine?.(line);
    });
    try {
      return await invoke<string>('install_session_provider', { tool });
    } finally {
      unlisten();
      preflightCache = null;
      catalogCache.delete(tool);
    }
  },
  slashCommands,
  hqSkillCatalog,
  hqSkillMetadata,
  hqCompanyProjects,
  hqSelf,
  hqRecentMeetings,
  hqSignals,
  hqVaultFiles,
  hqReferenceText,
  contextLoaders,
};
