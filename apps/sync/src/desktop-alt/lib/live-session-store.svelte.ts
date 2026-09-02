/**
 * Live in-app agent-session store (Sessions page).
 *
 * The ONE place the `agent_session_*` Tauri command surface and the three
 * `agent-session:*` events are spoken on the frontend. Everything above it —
 * the page, the list panel, the transcript, the composer — reads runes off
 * this module and calls its actions; nothing else invokes those commands.
 *
 * Correctness model (why the seq bookkeeping looks the way it does):
 *   - `agent_session_replay(sessionId, sinceSeq)` returns `(seq, event)` pairs
 *     with `seq >= sinceSeq`, plus the `nextSeq` to ask for next time. A full
 *     catch-up is `sinceSeq = 0`.
 *   - Live `agent-session:event` payloads carry the same seq. A payload whose
 *     seq is EXACTLY `nextSeq` appends; a lower seq is a duplicate and is
 *     dropped; a higher seq means we missed events (a dropped Tauri emit, a
 *     slow listener registration) and we re-replay from `nextSeq` rather than
 *     rendering a transcript with a hole in it.
 * That invariant is what lets the transcript be a pure fold of `events`.
 *
 * The fold itself (`foldSessionEvents`) is pure and lives with the components;
 * this module memoizes it on a revision counter so a render that only reads
 * `transcript` does not refold on every access.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { safeUnlisten } from '../../lib/listener-registry';
import type { SessionCommand, SessionEvent } from '../../components/sessions/session-events';
import {
  foldSessionEvents,
  type PendingCard,
  type TranscriptState,
} from '../../components/sessions/transcript-adapter';

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

/** One session the app is driving (Rust `SessionSummary`). */
export interface SessionSummary {
  sessionId: string;
  tool: SessionTool;
  phase: SessionPhase;
  company: string | null;
  model: string | null;
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
  companies: PreflightCompany[];
}

/** The CLI's slash-command catalog + model list, for the composer + picker. */
export interface CommandCatalog {
  commands: SessionCommand[];
  /** Free-form JSON from the CLI handshake; shape is not ours to pin. */
  models: unknown[];
}

/** `agent-session:event` payload. */
interface SessionEventPayload {
  sessionId: string;
  seq: number;
  event: SessionEvent;
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
  /** Requests already answered from this client, so their card can retire. */
  resolvedRequests: string[];
}

function newEntry(sessionId: string): SessionEntry {
  return {
    sessionId,
    events: [],
    nextSeq: 0,
    phase: 'starting',
    phaseObserved: false,
    truncated: false,
    loading: true,
    error: '',
    resolvedRequests: [],
  };
}

let entries = $state<Record<string, SessionEntry>>({});
let activeId = $state<string | null>(null);
let sessions = $state<SessionSummary[]>([]);
let listError = $state('');
let needsYou = $state<NeedsYouNotice | null>(null);
/** Bumped on every transcript-affecting mutation; the fold memo keys on it. */
let revision = $state(0);

let unlistenEvent: UnlistenFn | null = null;
let unlistenPhase: UnlistenFn | null = null;
let unlistenNeedsYou: UnlistenFn | null = null;
let listenersStarting = false;

let foldCache: { id: string; revision: number; value: TranscriptState } | null = null;

const EMPTY_TRANSCRIPT: TranscriptState = { messages: [], activity: [], pending: [] };

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Event plumbing
// ---------------------------------------------------------------------------

function applyEvent(sessionId: string, seq: number, event: SessionEvent): void {
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
  entry.nextSeq = seq + 1;
  revision += 1;
}

async function replayFrom(sessionId: string, sinceSeq: number): Promise<void> {
  const entry = entries[sessionId];
  if (!entry) return;
  try {
    const replay = await invoke<{
      events: [number, SessionEvent][];
      nextSeq: number;
      truncated: boolean;
    }>('agent_session_replay', { sessionId, sinceSeq });
    const target = entries[sessionId];
    if (!target) return;
    const incoming = replay.events.map(([, event]) => event);
    // `sinceSeq === 0` is a full catch-up: replace. A partial replay fills a
    // gap from the last contiguous seq forward, so it appends onto what we
    // already folded.
    target.events = sinceSeq === 0 ? incoming : [...target.events, ...incoming];
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
        applyEvent(payload.sessionId, payload.seq, payload.event);
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
  await replayFrom(sessionId, 0);
  await refreshList();
}

/** Drop a session's buffered transcript; unlisten once nothing is open. */
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

/** Send a user turn (or steer an in-flight one) to the active session. */
async function send(text: string): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_send', { sessionId, text });
}

/** Answer a parked permission request on the active session. */
async function respondPermission(
  requestId: string,
  decision: PermissionDecision,
): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_respond_permission', { sessionId, requestId, decision });
  markResolved(sessionId, requestId);
}

/** Answer a parked `AskUserQuestion` on the active session. */
async function answerQuestion(
  requestId: string,
  answers: QuestionAnswer[],
): Promise<void> {
  const sessionId = activeId;
  if (!sessionId) return;
  await invoke('agent_session_answer_question', { sessionId, requestId, answers });
  markResolved(sessionId, requestId);
}

/**
 * Retire a card locally. The backend emits no event when a request is answered
 * (`LiveSession::on_response_sent` only drops it from the registry's pending
 * map), so the fold — which only ever sees the ORIGINAL request event — would
 * otherwise keep showing an answered card forever.
 */
function markResolved(sessionId: string, requestId: string): void {
  const entry = entries[sessionId];
  if (!entry || entry.resolvedRequests.includes(requestId)) return;
  entry.resolvedRequests.push(requestId);
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

/** Can this machine run an in-app session, and what is missing if not? */
async function preflight(): Promise<Preflight> {
  return invoke<Preflight>('agent_session_preflight');
}

/** The CLI's slash-command catalog + model list. */
async function slashCommands(tool: SessionTool = 'claude'): Promise<CommandCatalog> {
  return invoke<CommandCatalog>('agent_session_slash_commands', { tool });
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
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

function activeEntry(): SessionEntry | null {
  return activeId ? (entries[activeId] ?? null) : null;
}

function transcriptOf(entry: SessionEntry | null): TranscriptState {
  if (!entry) return EMPTY_TRANSCRIPT;
  // Read the revision rune so every consumer of `transcript` stays subscribed
  // to transcript mutations even on a memo hit.
  const rev = revision;
  if (foldCache && foldCache.id === entry.sessionId && foldCache.revision === rev) {
    return foldCache.value;
  }
  const folded = foldSessionEvents(entry.events);
  const value: TranscriptState = entry.resolvedRequests.length
    ? { ...folded, pending: folded.pending.filter((card) => !isResolved(entry, card)) }
    : folded;
  foldCache = { id: entry.sessionId, revision: rev, value };
  return value;
}

function isResolved(entry: SessionEntry, card: PendingCard): boolean {
  return entry.resolvedRequests.includes(card.requestId);
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
  /** The seq to ask for on the next replay of the active session. */
  get nextSeq(): number {
    return activeEntry()?.nextSeq ?? 0;
  },
  /** Folded transcript of the active session, answered cards removed. */
  get transcript(): TranscriptState {
    return transcriptOf(activeEntry());
  },
  /** Cards the active session is blocked on, in arrival order. */
  get pending(): PendingCard[] {
    return transcriptOf(activeEntry()).pending;
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
  /** The active session's registry summary, when the list knows about it. */
  get summary(): SessionSummary | null {
    return sessions.find((s) => s.sessionId === activeId) ?? null;
  },
  open,
  close,
  refreshList,
  start,
  send,
  respondPermission,
  answerQuestion,
  interrupt,
  end,
  preflight,
  slashCommands,
};
