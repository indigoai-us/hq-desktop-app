// Fold a stream of session events into the chat transcript's render blocks.
//
// PURE: events (plus the caller's out-of-band context) in, one plain result
// out. No clock, no I/O, no mutation of the caller's arrays — the same input
// always folds to the same blocks, which is what makes this directly testable
// and what keeps the components presentation-pure.
//
// THE SHAPE OF THE ANSWER — this is a CHAT surface, not an event log:
//   - what the operator typed is a right-aligned bubble,
//   - what the agent said is plain prose,
//   - what the agent DID between two things it said is ONE quiet folded row
//     ("Ran 8 commands · edited 1 file · read 5 files") that expands,
//   - what the agent needs from the operator is an inline card at its position,
//   - lifecycle chatter (`started`, `turnDone`, `usage`) is NOT a row at all:
//     `usage` rides the composer footer and the rest is simply not news.
// Every event kind is still consumed; "not a row" is a decision, not a drop.
//
// TIMESTAMPS — an event's arrival instant is supplied by the caller in
// `receivedAt`, never synthesized here. The backend now stamps every buffered
// event with `receivedAtMs`, so both live and replayed events arrive dated;
// `null` remains legal and means "unknown", which keeps that event out of the
// day-divider decision. Inventing a time (the previous adapter's
// `startedAt + index * step`) is what produced the fake "Thursday, January 1
// 12:00 AM" divider.
//
// USER TURNS — two sources, one bubble. The backend records a `userMessage`
// event as it writes the turn to the CLI, so a replayed transcript contains
// the operator's own words. The store ALSO mirrors each send locally, in
// `userTurns`, so the bubble appears the instant Enter is pressed rather than
// after a round trip. The store drops its mirror for a session as soon as
// backend `userMessage` events land, so the two never both render; this fold
// simply honours whichever it is given.
//
// HOSTILE PAYLOADS — the wire is not the types. A `toolResult.content` is a
// Rust `serde_json::Value` and arrives as `null`, a string, an array of blocks
// or an object; every `Option<_>` arrives as `null`. Every string method on an
// event field therefore reads through `contentToText`, and the fold of each
// event is guarded: an event that still manages to throw is recorded in
// `foldErrors` and becomes ONE quiet line ("1 event could not be displayed"),
// never a blank window. The one time this was not true, opening the owner's
// most recent session crashed the whole desktop app on `null.split`.

import {
  contentToText,
  type PermissionSuggestion,
  type SessionEvent,
  type SessionQuestion,
} from './session-events';
import type { WsMember } from './session-types';
import { formatDayLabel } from './session-types';
import { isCheckpointDirective, isCheckpointTurn, isHandoffTurn } from './hook-notices';
import {
  emptyPolicyDigest,
  mergePolicyDigest,
  parsePolicyDigest,
  type PolicyDigest,
} from './policy-digest';
import { isStartworkTurn, splitStartworkEnvelope, startworkLabelFromText } from './startwork';
import { splitContextBlocks, type TurnAttachment } from './context-attachments';

export const SESSION_SELF_UID = 'you';
export const SESSION_AGENT_UID = 'agent';

/** The transcript's two participants: the operator and the agent they drive. */
export const SESSION_MEMBERS: WsMember[] = [
  { uid: SESSION_SELF_UID, displayName: 'You', kind: 'human', presence: 'online' },
  {
    uid: SESSION_AGENT_UID,
    displayName: 'Agent',
    kind: 'agent',
    presence: 'online',
    runtime: 'local',
  },
];

// ---------------------------------------------------------------------------
// Tool categories + the folded summary line
// ---------------------------------------------------------------------------

/**
 * The bucket a tool counts into on the folded row. `other` is the safety net —
 * an MCP tool, a Task, anything we have never seen — so a tool is never
 * silently uncounted.
 */
export const TOOL_CATEGORIES = [
  'command',
  'edit',
  'read',
  'search',
  'fetch',
  'todo',
  'other',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Map a tool name onto the bucket its work counts into. */
export function toolCategory(toolName: string): ToolCategory {
  switch (toolName) {
    case 'Bash':
    case 'bash':
    case 'BashOutput':
    case 'KillShell':
    case 'run_terminal_command':
      return 'command';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'write':
    case 'search_replace':
      return 'edit';
    case 'Read':
    case 'read_file':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
    case 'grep':
    case 'web_search':
      return 'search';
    case 'WebFetch':
    case 'web_fetch':
    case 'open_page':
      return 'fetch';
    case 'TodoWrite':
    case 'todo_write':
      return 'todo';
    default:
      return 'other';
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The one-line summary of a folded tool group — "Ran 8 commands · edited 1
 * file · read 5 files".
 *
 * Edits are counted by DISTINCT file, not by call: three edits to one file is
 * "edited 1 file", which is what the operator actually wants to know. A group
 * with nothing recognisable in it still reports its size ("3 tools") rather
 * than collapsing to an empty line, and any failure is named at the end.
 */
export function toolGroupSummary(calls: ReadonlyArray<ToolCallSummary>): string {
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let fetches = 0;
  let todos = 0;
  let other = 0;
  let failed = 0;
  const editedFiles: string[] = [];

  for (const call of calls) {
    if (call.status === 'error') failed += 1;
    switch (toolCategory(call.name)) {
      case 'command':
        commands += 1;
        break;
      case 'edit': {
        const file = call.detail || call.name;
        if (!editedFiles.includes(file)) editedFiles.push(file);
        break;
      }
      case 'read':
        reads += 1;
        break;
      case 'search':
        searches += 1;
        break;
      case 'fetch':
        fetches += 1;
        break;
      case 'todo':
        todos += 1;
        break;
      default:
        other += 1;
        break;
    }
  }

  const segments: string[] = [];
  if (commands > 0) segments.push(`ran ${plural(commands, 'command', 'commands')}`);
  if (editedFiles.length > 0) {
    segments.push(`edited ${plural(editedFiles.length, 'file', 'files')}`);
  }
  if (reads > 0) segments.push(`read ${plural(reads, 'file', 'files')}`);
  if (searches > 0) segments.push(`searched ${plural(searches, 'time', 'times')}`);
  if (fetches > 0) segments.push(`fetched ${plural(fetches, 'page', 'pages')}`);
  if (todos > 0) segments.push('updated todos');
  if (other > 0) segments.push(`used ${plural(other, 'tool', 'tools')}`);
  if (segments.length === 0) segments.push(plural(calls.length, 'tool', 'tools'));
  if (failed > 0) segments.push(`${failed} failed`);

  const summary = segments.join(' · ');
  return summary.charAt(0).toLocaleUpperCase('en-US') + summary.slice(1);
}

// ---------------------------------------------------------------------------
// Block model
// ---------------------------------------------------------------------------

/** One tool call inside a folded group, mutated in place as it resolves. */
export interface ToolCallSummary {
  id: string;
  name: string;
  /** One line describing the input — a command, a path, a pattern. Never a payload. */
  detail: string;
  status: 'running' | 'ok' | 'error';
  /** First lines of the tool result, for the expanded row. */
  outcome: string;
  /** Text a sub-agent streamed under this call, when it has one. */
  output: string;
  /**
   * The file this call wrote or edited, when it is one of the file tools and
   * named an absolute path. A multi-file Codex patch keeps its first path here;
   * the group's `artifacts` carries every one.
   */
  artifactPath?: string;
}

/** One file the agent produced in a turn, as the expanded tool row lists it. */
export interface ToolArtifact {
  path: string;
  /** Basename, for the row label. */
  name: string;
  kind: 'file';
}

/** How a decision card was answered from this client, for its collapsed line. */
export type CardResolution = 'Allowed' | 'Allowed for session' | 'Denied' | string;

export type ChatBlock =
  | {
      type: 'userBubble';
      id: string;
      text: string;
      /** "Attached: Meeting · title" tags under the words; never the raw block. */
      attachments: TurnAttachment[];
      at: number | null;
    }
  | {
      type: 'assistantProse';
      id: string;
      text: string;
      streaming: boolean;
      at: number | null;
    }
  /** The live "Thinking…" shimmer — only ever the tail, never history. */
  | { type: 'thinking'; id: string; text: string; at: number | null }
  | {
      type: 'toolGroup';
      id: string;
      summary: string;
      running: boolean;
      calls: ToolCallSummary[];
      /** Files the group's SUCCESSFUL file-tool calls produced, deduped by path. */
      artifacts: ToolArtifact[];
      at: number | null;
    }
  | {
      type: 'permissionCard';
      id: string;
      requestId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
      /** Non-null once answered from this client: the card collapses to a line. */
      resolution: CardResolution | null;
      at: number | null;
    }
  | {
      type: 'questionCard';
      id: string;
      requestId: string;
      questions: SessionQuestion[];
      resolution: CardResolution | null;
      at: number | null;
    }
  | {
      type: 'error';
      id: string;
      text: string;
      tone: 'error' | 'warn';
      /** The CLI's own error code, when the event carried one. */
      code?: string;
      /**
       * A recovery the line can offer inline. `chooseModel` is the
       * `model_not_found` case: the pill holds a model this CLI does not have,
       * and the fix is one click away rather than a sentence away.
       */
      action?: 'chooseModel' | 'reauth';
      at: number | null;
    }
  | { type: 'divider'; id: string; label: string; at: number | null };

// ---------------------------------------------------------------------------
// model_not_found — one line, not three
// ---------------------------------------------------------------------------

/** The Claude CLI's code for a model it cannot run. */
export const MODEL_NOT_FOUND_CODE = 'model_not_found';
export const AUTHENTICATION_FAILED_CODE = 'authentication_failed';

/** The one line the transcript says about it. */
export const MODEL_NOT_FOUND_TEXT = "The selected model isn't available.";

/**
 * The CLI ALSO narrates a `model_not_found` as assistant prose — "There's an
 * issue with the selected model (gpt-5.6-sol)… model_not_found" — and then
 * ends the turn with the same sentence as its error. Rendered literally that
 * is the same failure three times. This is how the prose is recognised so it
 * can fold into the one error line instead.
 */
export function isModelNotFoundText(text: string | null | undefined): boolean {
  if (!text) return false;
  return /issue with the selected model/i.test(text) || /\bmodel_not_found\b/i.test(text);
}

/** Two error sentences are the same news when they differ only in dressing. */
function normalizeErrorText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!\s]+$/g, '')
    .toLowerCase();
}

/** A decision the session is blocked on until the operator answers. */
export type PendingCard =
  | {
      type: 'permission';
      requestId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
    }
  | { type: 'question'; requestId: string; questions: SessionQuestion[] };

/** The last turn's cost, as the composer footer reports it. */
export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
  durationMs?: number | null;
  /** "2 in · 17 out · $0.68". */
  label: string;
}

/** One event the fold could not render — recorded, never fatal. */
export interface FoldError {
  /** Position in the event stream. */
  index: number;
  /** The event's `kind`, or `unknown` when even that could not be read. */
  kind: string;
  error: string;
}

/** The block id of the one line that stands in for every fold error. */
export const FOLD_ERRORS_BLOCK_ID = 'fold-errors';

/** "1 event could not be displayed (toolResult)" — the line those errors earn. */
export function foldErrorLabel(errors: ReadonlyArray<FoldError>): string {
  const kinds = [...new Set(errors.map((error) => error.kind))].join(', ');
  return `${plural(errors.length, 'event', 'events')} could not be displayed (${kinds})`;
}

export interface TranscriptState {
  blocks: ChatBlock[];
  /** Cards still awaiting an answer, in arrival order. */
  pending: PendingCard[];
  /** The most recent `usage` event, or null before the first turn settles. */
  lastUsage: UsageSummary | null;
  /** The CLI process is gone — the composer stops offering to send. */
  ended: boolean;
  /**
   * Every policy HQ's hooks said applies, deduped by slug, plus the bound
   * company. Folded from `hookNotice` events — never a row.
   */
  policies: PolicyDigest;
  /** A hook asked for a checkpoint and no `/checkpoint` turn has followed. */
  checkpointDue: boolean;
  /** How many checkpoint directives have arrived (dismissal is keyed on it). */
  checkpointPrompts: number;
  /** Where the latest `/handoff` turn stands: none sent, running, or written. */
  handoff: 'none' | 'running' | 'done';
  /**
   * Events that threw while folding, in stream order. Non-empty means the
   * transcript is missing something and says so in one line; it never means
   * the transcript failed to render.
   */
  foldErrors: FoldError[];
}

/** The state of a transcript with nothing in it. */
export function emptyTranscript(): TranscriptState {
  return {
    blocks: [],
    pending: [],
    lastUsage: null,
    ended: false,
    policies: emptyPolicyDigest(),
    checkpointDue: false,
    checkpointPrompts: 0,
    handoff: 'none',
    foldErrors: [],
  };
}

/**
 * What a user turn MEANS beyond its text. Carried on the mirrored turn, and
 * kept by the store (keyed by text) past the moment the mirror is dropped, so
 * the backend's own record of the same turn renders identically.
 */
export interface UserTurnMeta {
  /**
   * Not a bubble: a quiet system divider. The page marks the orientation
   * `/startwork` turn it sends before the user's first message this way.
   */
  hidden?: boolean;
  /** The divider's wording ("Starting work in indigo · project X"). */
  label?: string;
  /** Optional context divider rendered before this same atomic user turn. */
  contextLabel?: string;
  /** Visible bubble text when the wire message contains hidden context. */
  displayText?: string;
  /** The context chips that rode this turn. */
  attachments?: TurnAttachment[];
}

/** One locally-mirrored user turn (the event stream carries none). */
export interface UserTurn extends UserTurnMeta {
  id: string;
  text: string;
  /**
   * How many events had been folded when the turn was sent. The bubble is
   * emitted immediately before the event at this index, which is what puts it
   * above the answer it provoked.
   */
  atIndex: number;
  /** Wall-clock ms the turn was sent, or null when it cannot be known. */
  at: number | null;
}

export interface FoldOptions {
  /**
   * Wall-clock ms each event arrived, parallel to `events`. A replayed event
   * has no honest arrival time and passes `null`, which keeps it out of the
   * day-divider decision instead of inventing a date for it.
   */
  receivedAt?: ReadonlyArray<number | null>;
  /** The operator's own turns, mirrored by the store. */
  userTurns?: ReadonlyArray<UserTurn>;
  /** requestId → the verb this client answered it with. */
  resolutions?: Readonly<Record<string, CardResolution>>;
  /**
   * text → meta for turns this client sent, so a backend `userMessage` that
   * replaces the mirror keeps its hidden flag, its label and its tags.
   */
  turnMeta?: Readonly<Record<string, UserTurnMeta>>;
}

// ---------------------------------------------------------------------------
// Input summaries
// ---------------------------------------------------------------------------

/** The keys worth showing, in the order they best describe a call. */
const INPUT_KEYS = [
  'command',
  'file_path',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'url',
  'description',
  'prompt',
] as const;

const DETAIL_LIMIT = 160;

/** One-line label for a tool's input — never a whole payload. */
export function describeToolInput(input: unknown): string {
  const raw = rawToolInput(input);
  const single = raw.replace(/\s+/g, ' ').trim();
  return single.length > DETAIL_LIMIT ? `${single.slice(0, DETAIL_LIMIT)}…` : single;
}

function rawToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    for (const key of INPUT_KEYS) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Artifacts — the files a turn produced
// ---------------------------------------------------------------------------

/** The tools whose input names a file the agent is writing. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);

/** `/abs/path` or `C:\abs\path` — a relative path cannot be acted on. */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * Every absolute file path a tool call produced, in input order.
 *
 * Claude's file tools name one `file_path` (`notebook_path` for notebooks);
 * Codex's `fileChange` items arrive as `Write` / `Edit` / `ApplyPatch` with a
 * `changes: [{ path, kind }]` array, where a `delete` produces nothing. A tool
 * that is not a file tool, or an input with no absolute path, yields nothing
 * — a Bash command that happens to create a file is deliberately not parsed.
 */
export function toolArtifactPaths(toolName: string, input: unknown): string[] {
  if (!FILE_TOOLS.has(toolName)) return [];
  if (!input || typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && isAbsolutePath(value) && !out.includes(value)) {
      out.push(value);
    }
  };
  add(record.file_path);
  add(record.notebook_path);
  if (Array.isArray(record.changes)) {
    for (const change of record.changes) {
      if (!change || typeof change !== 'object') continue;
      const entry = change as Record<string, unknown>;
      if (entry.kind === 'delete') continue;
      add(entry.path);
    }
  }
  return out;
}

function artifactName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Cap a tool result to a readable head rather than pasting a whole log. */
const OUTCOME_LINES = 12;
const OUTCOME_CHARS = 1200;

function clipOutcome(content: unknown): string {
  // `content` is a `serde_json::Value` on the wire: null, string, blocks, object.
  const lines = contentToText(content).split('\n');
  const head = lines.slice(0, OUTCOME_LINES).join('\n');
  const clipped = head.length > OUTCOME_CHARS ? `${head.slice(0, OUTCOME_CHARS)}…` : head;
  return lines.length > OUTCOME_LINES ? `${clipped}\n…` : clipped;
}

// ---------------------------------------------------------------------------
// Wire coercions — what the types promise, made true
// ---------------------------------------------------------------------------

/** A number the wire may have sent as `null`, a string, or not at all. */
function finiteOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** A `permissionRequest`'s suggestions as the list the card expects — the wire says `Value`. */
function suggestionsOf(value: unknown): PermissionSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is PermissionSuggestion => typeof entry === 'object' && entry !== null,
  );
}

/** A `questionRequest`'s questions with every field the card reads made safe to read. */
function questionsOf(value: unknown): SessionQuestion[] {
  if (!Array.isArray(value)) return [];
  const out: SessionQuestion[] = [];
  value.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const record = raw as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options
          .filter((option) => option && typeof option === 'object')
          .map((option) => {
            const entry = option as Record<string, unknown>;
            return typeof entry.description === 'string'
              ? { label: contentToText(entry.label), description: entry.description }
              : { label: contentToText(entry.label) };
          })
      : [];
    out.push({
      id: contentToText(record.id) || `q${index}`,
      header: contentToText(record.header),
      text: contentToText(record.text),
      options,
      multiSelect: record.multiSelect === true,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** "1,240" → "1.2k", so a long turn's footer stays one quiet line. */
function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

function usageLabel(usage: {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
  durationMs?: number | null;
}): string {
  const parts = [
    `${compactTokens(usage.inputTokens)} in`,
    `${compactTokens(usage.outputTokens)} out`,
  ];
  // Codex reports no dollar cost: the Rust `Option<f64>` arrives as `null`, not
  // `undefined`, so an `!== undefined` guard let `null.toFixed` crash the page.
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    parts.push(`$${usage.costUsd.toFixed(2)}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// The fold
// ---------------------------------------------------------------------------

/** UTC day key of a wall-clock instant, for the divider decision. */
function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function foldSessionEvents(
  events: ReadonlyArray<SessionEvent>,
  options: FoldOptions = {},
): TranscriptState {
  const receivedAt = options.receivedAt ?? [];
  const resolutions = options.resolutions ?? {};
  const turnMeta = options.turnMeta ?? {};
  // Sorted on a copy so a caller's array is never mutated.
  const turns = [...(options.userTurns ?? [])].sort((a, b) => a.atIndex - b.atIndex);

  const blocks: ChatBlock[] = [];
  const pending: PendingCard[] = [];
  let lastUsage: UsageSummary | null = null;
  let ended = false;
  let policies = emptyPolicyDigest();
  let checkpointDue = false;
  let checkpointPrompts = 0;
  let handoff: TranscriptState['handoff'] = 'none';
  const foldErrors: FoldError[] = [];

  /** The assistant prose row currently streaming at the top level, if any. */
  let openProse: Extract<ChatBlock, { type: 'assistantProse' }> | null = null;
  /** The tool group still accepting calls, if any. */
  let openGroup: Extract<ChatBlock, { type: 'toolGroup' }> | null = null;
  /** The live thinking row, retired the moment the agent says anything. */
  let openThought: Extract<ChatBlock, { type: 'thinking' }> | null = null;
  /** Every open call, so a result can close the row it belongs to. */
  const callsById = new Map<string, ToolCallSummary>();
  /** Thinking rows that were superseded; filtered out at the end. */
  const retired = new Set<string>();
  /** Every path a file tool named, by group — settled into `artifacts` at the end. */
  const producedByGroup = new Map<string, { path: string; call: ToolCallSummary }[]>();

  let lastDay = '';
  let nextTurn = 0;

  /**
   * The error sentences already on screen for the CURRENT turn, normalized.
   * A `turnDone` that repeats an `error` event's message, or an `error` event
   * that repeats the prose, adds nothing and is not a second line.
   */
  let turnErrors = new Set<string>();
  /** The turn's one `model_not_found` line, once it exists. */
  let turnModelError: Extract<ChatBlock, { type: 'error' }> | null = null;

  /** A user turn starts a new turn: its errors are its own. */
  function resetTurnErrors(): void {
    turnErrors = new Set<string>();
    turnModelError = null;
  }

  /**
   * The one `model_not_found` line for this turn. The first sighting — the
   * prose, the `error` event, or the `turnDone`, whichever the wire delivers
   * first — creates it; every later sighting in the same turn folds into it.
   */
  function modelNotFoundLine(index: number, at: number | null): void {
    if (turnModelError) return;
    const block: Extract<ChatBlock, { type: 'error' }> = {
      type: 'error',
      id: `error-${index}`,
      tone: 'error',
      text: MODEL_NOT_FOUND_TEXT,
      code: MODEL_NOT_FOUND_CODE,
      action: 'chooseModel',
      at,
    };
    turnModelError = block;
    turnErrors.add(normalizeErrorText(MODEL_NOT_FOUND_TEXT));
    push(block);
  }

  /**
   * An error sentence for this turn, unless the same sentence is already on
   * screen. Returns whether a line was added.
   */
  function errorLine(
    index: number,
    at: number | null,
    message: string,
    tone: 'error' | 'warn',
    code?: string,
  ): boolean {
    const key = normalizeErrorText(message);
    if (key.length > 0 && turnErrors.has(key)) return false;
    turnErrors.add(key);
    // The rendered line carries the code; a later `turnDone` repeats only the
    // sentence, so the sentence is what is remembered.
    const text = code ? `${message} (${code})` : message;
    const auth =
      code === AUTHENTICATION_FAILED_CODE ||
      /authenticate|oauth access token has been revoked/i.test(message);
    push(
      code === undefined
        ? { type: 'error', id: `${tone === 'warn' ? 'rate' : 'error'}-${index}`, tone, text, at }
        : {
            type: 'error',
            id: `error-${index}`,
            tone,
            text,
            code,
            at,
            ...(auth ? { action: 'reauth' as const } : {}),
          },
    );
    return true;
  }

  /**
   * Prose that is really the CLI narrating a `model_not_found`: never a
   * paragraph. Whatever of it already streamed is withdrawn, and the turn's
   * one error line stands in its place. Returns true when the text was absorbed.
   */
  function absorbModelError(text: string, index: number, at: number | null): boolean {
    if (!isModelNotFoundText(text)) return false;
    if (openProse) {
      retired.add(openProse.id);
      openProse = null;
    }
    modelNotFoundLine(index, at);
    return true;
  }

  /** Emit a day divider when a real-dated block crosses a UTC date boundary. */
  function markDay(at: number | null): void {
    if (at === null) return;
    const day = dayKey(at);
    if (lastDay === '') {
      lastDay = day;
      return;
    }
    if (day === lastDay) return;
    lastDay = day;
    blocks.push({
      type: 'divider',
      id: `day-${day}`,
      label: formatDayLabel(new Date(at).toISOString()),
      at,
    });
  }

  function push(block: ChatBlock): void {
    markDay(block.at);
    blocks.push(block);
  }

  /** The agent has said or done something: the "Thinking…" shimmer is over. */
  function retireThought(): void {
    if (!openThought) return;
    retired.add(openThought.id);
    openThought = null;
  }

  function closeGroup(): void {
    openGroup = null;
  }

  /**
   * A finished turn (or a hard session end) is the last word on open tools.
   * Grok often never sends a matching toolResult after prompt_complete; leave
   * those calls `running` and the folded row spins after Idle — and expanding
   * it remounts live artifact stats for every still-open write.
   */
  function settleOpenCalls(): void {
    for (const call of callsById.values()) {
      if (call.status === 'running') call.status = 'ok';
    }
  }

  function closeProse(): void {
    if (openProse) openProse.streaming = false;
    openProse = null;
  }

  /**
   * A user turn's slash command moves session state: `/handoff` starts a
   * handoff the next `turnDone` finishes, `/checkpoint` answers a pending
   * checkpoint prompt. Mirrored and backend-recorded turns both pass here.
   */
  function noteUserTurn(text: string): void {
    if (isHandoffTurn(text)) handoff = 'running';
    if (isCheckpointTurn(text)) checkpointDue = false;
  }

  /** The group a tool call joins — a new one after any prose. */
  function groupFor(at: number | null): Extract<ChatBlock, { type: 'toolGroup' }> {
    if (openGroup) return openGroup;
    const group: Extract<ChatBlock, { type: 'toolGroup' }> = {
      type: 'toolGroup',
      id: `tools-${blocks.length}`,
      summary: '',
      running: true,
      calls: [],
      artifacts: [],
      at,
    };
    openGroup = group;
    push(group);
    return group;
  }

  /**
   * One user turn, mirrored or backend-recorded, as its block. A hidden turn
   * (the page's orientation `/startwork`, or any `/startwork` the backend
   * recorded once the mirror was gone) is a system divider, never a bubble;
   * everything else is a bubble whose words exclude the context block and
   * whose tags name what rode along.
   */
  function userBlocks(id: string, text: string, meta: UserTurnMeta, at: number | null): ChatBlock[] {
    const envelope = splitStartworkEnvelope(text);
    const hidden = meta.hidden ?? (envelope ? false : isStartworkTurn(text));
    if (hidden) {
      return [{
        type: 'divider',
        id: `sys-${id}`,
        label: meta.label ?? (isStartworkTurn(text) ? startworkLabelFromText(text) : text),
        at,
      }];
    }
    const split = splitContextBlocks(meta.displayText ?? envelope?.prompt ?? text);
    const bubble: ChatBlock = {
      type: 'userBubble',
      id: `user-${id}`,
      text: split.text,
      attachments: meta.attachments ?? split.attachments,
      at,
    };
    const contextLabel = meta.contextLabel ?? envelope?.command;
    return contextLabel
      ? [{ type: 'divider', id: `sys-context-${id}`, label: contextLabel, at }, bubble]
      : [bubble];
  }

  /** Emit every mirrored user turn that belongs before event `index`. */
  function drainTurns(index: number): void {
    while (nextTurn < turns.length && turns[nextTurn]!.atIndex <= index) {
      const turn = turns[nextTurn]!;
      nextTurn += 1;
      // A user turn is the hardest boundary there is: it ends the agent's
      // previous prose, group and thought.
      closeProse();
      closeGroup();
      retireThought();
      resetTurnErrors();
      const text = contentToText(turn.text);
      noteUserTurn(text);
      for (const block of userBlocks(turn.id, text, turn, turn.at)) push(block);
    }
  }

  /** Fold ONE event. Anything it throws is caught by the loop below. */
  function foldOne(event: SessionEvent, index: number, at: number | null): void {
    switch (event.kind) {
      // `started` is not news: the strip already names the company and model,
      // and a "Started claude (opus) in /Users/…" banner is exactly the
      // technical narration a chat surface should not open with.
      case 'started':
        break;

      // The operator's own turn, as the backend recorded it. Rendered exactly
      // like a mirrored one — a user turn is the hardest boundary in the
      // transcript, so it closes whatever the agent had open.
      case 'userMessage': {
        const text = contentToText(event.text);
        closeProse();
        closeGroup();
        retireThought();
        resetTurnErrors();
        noteUserTurn(text);
        for (const block of userBlocks(`ev-${index}`, text, turnMeta[text] ?? {}, at)) push(block);
        break;
      }

      // Not a row: what a hook told the model is session STATE — the policies
      // chip in the strip, the checkpoint prompt above the composer — not
      // something the operator said or the agent answered.
      case 'hookNotice': {
        const text = contentToText(event.text);
        policies = mergePolicyDigest(policies, parsePolicyDigest(text));
        if (isCheckpointDirective(text)) {
          checkpointDue = true;
          checkpointPrompts += 1;
        }
        break;
      }

      case 'textDelta': {
        const text = contentToText(event.text);
        if (event.parentToolUseId) {
          subAgentCall(event.parentToolUseId, at).output += text;
          break;
        }
        retireThought();
        closeGroup();
        // A turn that already failed on its model has nothing to say: the
        // CLI's narration of that failure is the error line, not a paragraph.
        if (turnModelError) break;
        if (openProse) {
          openProse.text += text;
          absorbModelError(openProse.text, index, at);
        } else {
          if (absorbModelError(text, index, at)) break;
          const prose: Extract<ChatBlock, { type: 'assistantProse' }> = {
            type: 'assistantProse',
            id: `say-${index}`,
            text,
            streaming: true,
            at,
          };
          openProse = prose;
          push(prose);
        }
        break;
      }

      case 'assistantMessage': {
        const text = contentToText(event.text);
        if (event.parentToolUseId) {
          subAgentCall(event.parentToolUseId, at).output = text;
          break;
        }
        retireThought();
        closeGroup();
        if (turnModelError) break;
        if (absorbModelError(text, index, at)) break;
        if (openProse) {
          // The finalized text is authoritative — the deltas were a preview of
          // exactly this string, so it replaces rather than appends.
          openProse.text = text;
          openProse.streaming = false;
          openProse = null;
        } else {
          push({
            type: 'assistantProse',
            id: `say-${index}`,
            text,
            streaming: false,
            at,
          });
        }
        break;
      }

      case 'thinkingDelta': {
        const text = contentToText(event.text);
        if (openThought) {
          openThought.text += text;
          break;
        }
        closeProse();
        const thought: Extract<ChatBlock, { type: 'thinking' }> = {
          type: 'thinking',
          id: `think-${index}`,
          text,
          at,
        };
        openThought = thought;
        push(thought);
        break;
      }

      case 'toolCall': {
        retireThought();
        closeProse();
        // A call with no id still gets a row; a call with no name is "Tool".
        const id = contentToText(event.id) || `call-${index}`;
        const name = contentToText(event.name) || 'Tool';
        const existing = callsById.get(id);
        if (existing) {
          // Grok (and other ACP hosts) re-announce the same toolCallId on
          // tool_call_update. A second row would stay `running` forever after
          // the result lands on the first object — spinner never stops, and
          // expanding duplicates the list enough to take the webview down.
          if (name && name !== 'Tool') existing.name = name;
          const detail = describeToolInput(event.input);
          if (detail) existing.detail = detail;
          break;
        }
        const call: ToolCallSummary = {
          id,
          name,
          detail: describeToolInput(event.input),
          status: 'running',
          outcome: '',
          output: '',
        };
        const produced = toolArtifactPaths(name, event.input);
        if (produced.length > 0) call.artifactPath = produced[0];
        callsById.set(id, call);
        const group = groupFor(at);
        group.calls.push(call);
        if (produced.length > 0) {
          const list = producedByGroup.get(group.id) ?? [];
          for (const path of produced) list.push({ path, call });
          producedByGroup.set(group.id, list);
        }
        break;
      }

      case 'toolResult': {
        const id = contentToText(event.id);
        const call = callsById.get(id);
        if (call) {
          call.status = event.isError === true ? 'error' : 'ok';
          call.outcome = clipOutcome(event.content);
          break;
        }
        // A result whose call fell outside the replay window still deserves a
        // row rather than silent loss.
        const orphan: ToolCallSummary = {
          id: id || `result-${index}`,
          name: 'Tool',
          detail: id,
          status: event.isError === true ? 'error' : 'ok',
          outcome: clipOutcome(event.content),
          output: '',
        };
        callsById.set(orphan.id, orphan);
        groupFor(at).calls.push(orphan);
        break;
      }

      case 'permissionRequest': {
        retireThought();
        closeProse();
        closeGroup();
        const requestId = contentToText(event.requestId) || `perm-${index}`;
        const toolName = contentToText(event.toolName) || 'Tool';
        const suggestions = suggestionsOf(event.suggestions);
        const resolution = resolutions[requestId] ?? null;
        push({
          type: 'permissionCard',
          id: `perm-${requestId}`,
          requestId,
          toolName,
          input: event.input,
          suggestions,
          resolution,
          at,
        });
        if (!resolution) {
          pending.push({
            type: 'permission',
            requestId,
            toolName,
            input: event.input,
            suggestions,
          });
        }
        break;
      }

      case 'questionRequest': {
        retireThought();
        closeProse();
        closeGroup();
        const requestId = contentToText(event.requestId) || `question-${index}`;
        const questions = questionsOf(event.questions);
        const resolution = resolutions[requestId] ?? null;
        push({
          type: 'questionCard',
          id: `question-${requestId}`,
          requestId,
          questions,
          resolution,
          at,
        });
        if (!resolution) {
          pending.push({ type: 'question', requestId, questions });
        }
        break;
      }

      // Not a row: the last turn's cost belongs on the composer footer, where
      // it is available without pushing the conversation up.
      case 'usage': {
        const usage = {
          inputTokens: finiteOr0(event.inputTokens),
          outputTokens: finiteOr0(event.outputTokens),
          costUsd: typeof event.costUsd === 'number' ? event.costUsd : null,
          durationMs: typeof event.durationMs === 'number' ? event.durationMs : null,
        };
        lastUsage = { ...usage, label: usageLabel(usage) };
        break;
      }

      case 'rateLimit': {
        retireThought();
        closeProse();
        closeGroup();
        const message = contentToText(event.message);
        const resetsAt = contentToText(event.resetsAt);
        errorLine(
          index,
          at,
          resetsAt ? `Rate limited: ${message} (resets ${resetsAt})` : `Rate limited: ${message}`,
          'warn',
        );
        break;
      }

      case 'truncated': {
        closeProse();
        closeGroup();
        push({
          type: 'divider',
          id: `truncated-${index}`,
          label: `${finiteOr0(event.dropped)} older events dropped`,
          at,
        });
        break;
      }

      // Not a row when it succeeded — "Turn complete." is noise the reader can
      // already see. A turn that failed IS news, so it keeps a line.
      case 'turnDone': {
        retireThought();
        closeProse();
        settleOpenCalls();
        closeGroup();
        // The turn a `/handoff` started has ended: written on success, and
        // simply over (the error row below says why) on anything else.
        if (handoff === 'running') {
          handoff = event.status === 'success' ? 'done' : 'none';
          if (handoff === 'done') {
            push({ type: 'divider', id: `handoff-${index}`, label: 'Session handed off', at });
          }
        }
        if (event.status === 'interrupted') {
          push({ type: 'error', id: `turn-${index}`, tone: 'warn', text: 'Stopped.', at });
        } else if (event.status !== 'success') {
          // The turn's failure was already said: an `error` event with the
          // same sentence, or the one `model_not_found` line. "Turn failed: …"
          // repeating it is the third copy the owner saw.
          const error = contentToText(event.error);
          const already =
            (error !== '' && turnErrors.has(normalizeErrorText(error))) ||
            (turnModelError !== null && isModelNotFoundText(error));
          if (error && isModelNotFoundText(error)) {
            modelNotFoundLine(index, at);
          } else if (!already) {
            push({
              type: 'error',
              id: `turn-${index}`,
              tone: 'error',
              text: `Turn failed${error ? `: ${error}` : ''}.`,
              at,
            });
          }
        }
        break;
      }

      case 'error': {
        retireThought();
        closeProse();
        settleOpenCalls();
        closeGroup();
        const message = contentToText(event.message);
        const code = typeof event.code === 'string' ? event.code : undefined;
        if (code === MODEL_NOT_FOUND_CODE || isModelNotFoundText(message)) {
          modelNotFoundLine(index, at);
          break;
        }
        errorLine(index, at, message, 'error', code);
        break;
      }

      case 'exited': {
        retireThought();
        closeProse();
        settleOpenCalls();
        closeGroup();
        ended = true;
        push({ type: 'divider', id: `exited-${index}`, label: 'Session ended', at });
        break;
      }
    }
  }

  events.forEach((event, index) => {
    drainTurns(index);
    const at = receivedAt[index] ?? null;
    // One hostile event is one recorded error, never a blank window. The kind
    // is read inside the guard too: a payload can be hostile all the way down.
    let kind = 'unknown';
    try {
      kind = contentToText((event as { kind?: unknown } | null)?.kind) || 'unknown';
      foldOne(event, index, at);
    } catch (err) {
      foldErrors.push({ index, kind, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Anything the operator sent after the last event we have folded (the common
  // case for the very first send: the bubble exists before any reply does).
  drainTurns(events.length);

  // Everything that could not be shown, said once, quietly, at the end.
  if (foldErrors.length > 0) {
    blocks.push({
      type: 'divider',
      id: FOLD_ERRORS_BLOCK_ID,
      label: foldErrorLabel(foldErrors),
      at: null,
    });
  }

  for (const block of blocks) {
    if (block.type === 'toolGroup') {
      block.summary = toolGroupSummary(block.calls);
      block.running = block.calls.some((call) => call.status === 'running');
      // Only a call that finished cleanly produced anything; a failed or
      // still-running write is not yet a file the operator can act on.
      const seen = new Set<string>();
      block.artifacts = (producedByGroup.get(block.id) ?? [])
        .filter(({ path, call }) => call.status === 'ok' && !seen.has(path) && seen.add(path))
        .map(({ path }) => ({ path, name: artifactName(path), kind: 'file' as const }));
    }
  }

  return {
    blocks: blocks.filter((block) => !retired.has(block.id)),
    pending,
    lastUsage,
    ended,
    policies,
    checkpointDue,
    checkpointPrompts,
    handoff,
    foldErrors,
  };

  /**
   * The tool row a sub-agent's stream belongs to. Sub-agent prose must never
   * be spliced into the top-level answer, so an orphaned parent id gets a row
   * of its own rather than a paragraph.
   */
  function subAgentCall(parentToolUseId: string, at: number | null): ToolCallSummary {
    const known = callsById.get(parentToolUseId);
    if (known) return known;
    const call: ToolCallSummary = {
      id: parentToolUseId,
      name: 'Task',
      detail: 'sub-agent',
      status: 'running',
      outcome: '',
      output: '',
    };
    callsById.set(parentToolUseId, call);
    groupFor(at).calls.push(call);
    return call;
  }
}
