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

import type {
  PermissionSuggestion,
  SessionEvent,
  SessionQuestion,
} from './session-events';
import type { WsMember } from './session-types';
import { formatDayLabel } from './session-types';

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
    case 'BashOutput':
    case 'KillShell':
      return 'command';
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return 'edit';
    case 'Read':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
      return 'search';
    case 'WebFetch':
      return 'fetch';
    case 'TodoWrite':
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
}

/** How a decision card was answered from this client, for its collapsed line. */
export type CardResolution = 'Allowed' | 'Allowed for session' | 'Denied' | string;

export type ChatBlock =
  | { type: 'userBubble'; id: string; text: string; at: number | null }
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
  | { type: 'error'; id: string; text: string; tone: 'error' | 'warn'; at: number | null }
  | { type: 'divider'; id: string; label: string; at: number | null };

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
  costUsd?: number;
  durationMs?: number;
  /** "2 in · 17 out · $0.68". */
  label: string;
}

export interface TranscriptState {
  blocks: ChatBlock[];
  /** Cards still awaiting an answer, in arrival order. */
  pending: PendingCard[];
  /** The most recent `usage` event, or null before the first turn settles. */
  lastUsage: UsageSummary | null;
  /** The CLI process is gone — the composer stops offering to send. */
  ended: boolean;
}

/** One locally-mirrored user turn (the event stream carries none). */
export interface UserTurn {
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

/** Cap a tool result to a readable head rather than pasting a whole log. */
const OUTCOME_LINES = 12;
const OUTCOME_CHARS = 1200;

function clipOutcome(content: string): string {
  const lines = content.split('\n');
  const head = lines.slice(0, OUTCOME_LINES).join('\n');
  const clipped = head.length > OUTCOME_CHARS ? `${head.slice(0, OUTCOME_CHARS)}…` : head;
  return lines.length > OUTCOME_LINES ? `${clipped}\n…` : clipped;
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
  costUsd?: number;
  durationMs?: number;
}): string {
  const parts = [
    `${compactTokens(usage.inputTokens)} in`,
    `${compactTokens(usage.outputTokens)} out`,
  ];
  if (usage.costUsd !== undefined) parts.push(`$${usage.costUsd.toFixed(2)}`);
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
  // Sorted on a copy so a caller's array is never mutated.
  const turns = [...(options.userTurns ?? [])].sort((a, b) => a.atIndex - b.atIndex);

  const blocks: ChatBlock[] = [];
  const pending: PendingCard[] = [];
  let lastUsage: UsageSummary | null = null;
  let ended = false;

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

  let lastDay = '';
  let nextTurn = 0;

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

  function closeProse(): void {
    if (openProse) openProse.streaming = false;
    openProse = null;
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
      at,
    };
    openGroup = group;
    push(group);
    return group;
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
      push({ type: 'userBubble', id: `user-${turn.id}`, text: turn.text, at: turn.at });
    }
  }

  events.forEach((event, index) => {
    drainTurns(index);
    const at = receivedAt[index] ?? null;

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
        closeProse();
        closeGroup();
        retireThought();
        push({ type: 'userBubble', id: `user-ev-${index}`, text: event.text, at });
        break;
      }

      case 'textDelta': {
        if (event.parentToolUseId) {
          subAgentCall(event.parentToolUseId, at).output += event.text;
          break;
        }
        retireThought();
        closeGroup();
        if (openProse) {
          openProse.text += event.text;
        } else {
          const prose: Extract<ChatBlock, { type: 'assistantProse' }> = {
            type: 'assistantProse',
            id: `say-${index}`,
            text: event.text,
            streaming: true,
            at,
          };
          openProse = prose;
          push(prose);
        }
        break;
      }

      case 'assistantMessage': {
        if (event.parentToolUseId) {
          subAgentCall(event.parentToolUseId, at).output = event.text;
          break;
        }
        retireThought();
        closeGroup();
        if (openProse) {
          // The finalized text is authoritative — the deltas were a preview of
          // exactly this string, so it replaces rather than appends.
          openProse.text = event.text;
          openProse.streaming = false;
          openProse = null;
        } else {
          push({
            type: 'assistantProse',
            id: `say-${index}`,
            text: event.text,
            streaming: false,
            at,
          });
        }
        break;
      }

      case 'thinkingDelta': {
        if (openThought) {
          openThought.text += event.text;
          break;
        }
        closeProse();
        const thought: Extract<ChatBlock, { type: 'thinking' }> = {
          type: 'thinking',
          id: `think-${index}`,
          text: event.text,
          at,
        };
        openThought = thought;
        push(thought);
        break;
      }

      case 'toolCall': {
        retireThought();
        closeProse();
        const call: ToolCallSummary = {
          id: event.id,
          name: event.name,
          detail: describeToolInput(event.input),
          status: 'running',
          outcome: '',
          output: '',
        };
        callsById.set(event.id, call);
        const group = groupFor(at);
        group.calls.push(call);
        break;
      }

      case 'toolResult': {
        const call = callsById.get(event.id);
        if (call) {
          call.status = event.isError ? 'error' : 'ok';
          call.outcome = clipOutcome(event.content);
          break;
        }
        // A result whose call fell outside the replay window still deserves a
        // row rather than silent loss.
        const orphan: ToolCallSummary = {
          id: event.id,
          name: 'Tool',
          detail: event.id,
          status: event.isError ? 'error' : 'ok',
          outcome: clipOutcome(event.content),
          output: '',
        };
        callsById.set(event.id, orphan);
        groupFor(at).calls.push(orphan);
        break;
      }

      case 'permissionRequest': {
        retireThought();
        closeProse();
        closeGroup();
        const resolution = resolutions[event.requestId] ?? null;
        push({
          type: 'permissionCard',
          id: `perm-${event.requestId}`,
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          suggestions: event.suggestions,
          resolution,
          at,
        });
        if (!resolution) {
          pending.push({
            type: 'permission',
            requestId: event.requestId,
            toolName: event.toolName,
            input: event.input,
            suggestions: event.suggestions,
          });
        }
        break;
      }

      case 'questionRequest': {
        retireThought();
        closeProse();
        closeGroup();
        const resolution = resolutions[event.requestId] ?? null;
        push({
          type: 'questionCard',
          id: `question-${event.requestId}`,
          requestId: event.requestId,
          questions: event.questions,
          resolution,
          at,
        });
        if (!resolution) {
          pending.push({
            type: 'question',
            requestId: event.requestId,
            questions: event.questions,
          });
        }
        break;
      }

      // Not a row: the last turn's cost belongs on the composer footer, where
      // it is available without pushing the conversation up.
      case 'usage': {
        lastUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          label: usageLabel(event),
        };
        break;
      }

      case 'rateLimit': {
        retireThought();
        closeProse();
        closeGroup();
        push({
          type: 'error',
          id: `rate-${index}`,
          tone: 'warn',
          text: event.resetsAt
            ? `Rate limited: ${event.message} (resets ${event.resetsAt})`
            : `Rate limited: ${event.message}`,
          at,
        });
        break;
      }

      case 'truncated': {
        closeProse();
        closeGroup();
        push({
          type: 'divider',
          id: `truncated-${index}`,
          label: `${event.dropped} older events dropped`,
          at,
        });
        break;
      }

      // Not a row when it succeeded — "Turn complete." is noise the reader can
      // already see. A turn that failed IS news, so it keeps a line.
      case 'turnDone': {
        retireThought();
        closeProse();
        closeGroup();
        if (event.status !== 'success') {
          push({
            type: 'error',
            id: `turn-${index}`,
            tone: event.status === 'interrupted' ? 'warn' : 'error',
            text:
              event.status === 'interrupted'
                ? 'Stopped.'
                : `Turn failed${event.error ? `: ${event.error}` : ''}.`,
            at,
          });
        }
        break;
      }

      case 'error': {
        retireThought();
        closeProse();
        closeGroup();
        push({
          type: 'error',
          id: `error-${index}`,
          tone: 'error',
          text: event.code ? `${event.message} (${event.code})` : event.message,
          at,
        });
        break;
      }

      case 'exited': {
        retireThought();
        closeProse();
        closeGroup();
        ended = true;
        push({ type: 'divider', id: `exited-${index}`, label: 'Session ended', at });
        break;
      }
    }
  });

  // Anything the operator sent after the last event we have folded (the common
  // case for the very first send: the bubble exists before any reply does).
  drainTurns(events.length);

  for (const block of blocks) {
    if (block.type === 'toolGroup') {
      block.summary = toolGroupSummary(block.calls);
      block.running = block.calls.some((call) => call.status === 'running');
    }
  }

  return {
    blocks: blocks.filter((block) => !retired.has(block.id)),
    pending,
    lastUsage,
    ended,
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
