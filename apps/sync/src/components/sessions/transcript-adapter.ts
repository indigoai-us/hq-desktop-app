// Fold a stream of session events into the transcript's render props.
//
// PURE: one input array in, one plain result out. No clock, no I/O, no
// mutation of the caller's array — the same events always fold to the same
// transcript, which is what makes this testable and what keeps the components
// presentation-pure.
//
// Timestamps: session events carry no wall-clock of their own, so the fold
// assigns a deterministic monotonic `createdAt` — `startedAt + index * stepMs`
// — which is enough for day dividers, grouping, and stable ordering. A live
// host passes the real session start time.

import type {
  PermissionSuggestion,
  SessionEvent,
  SessionQuestion,
} from './session-events';
import type {
  WsActivityClass,
  WsActivityItem,
  WsMember,
  WsMessage,
} from './session-types';

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

/** A decision the transcript is blocked on until the operator answers. */
export type PendingCard =
  | {
      type: 'permission';
      requestId: string;
      toolName: string;
      input: unknown;
      suggestions: PermissionSuggestion[];
      /** The `waiting-approval` activity row this card mirrors. */
      activityId: string;
    }
  | { type: 'question'; requestId: string; questions: SessionQuestion[] };

export interface TranscriptState {
  messages: WsMessage[];
  activity: WsActivityItem[];
  pending: PendingCard[];
}

export interface FoldOptions {
  /** ISO-8601 UTC instant the session started. */
  startedAt?: string;
  /** Milliseconds between consecutive events. */
  stepMs?: number;
}

/** Deterministic default so a fixture-driven render never drifts between runs. */
const DEFAULT_STARTED_AT = '2026-01-01T00:00:00.000Z';
const DEFAULT_STEP_MS = 1000;

/**
 * Map a tool name onto its presentation class. Everything unrecognised — MCP
 * tools included — lands in `generic-tool` rather than being dropped: the
 * ambient safety net is the point of that class.
 */
export function activityClassForTool(toolName: string): WsActivityClass {
  if (toolName === 'Bash') return 'shell-command';
  if (toolName === 'Edit' || toolName === 'Write') return 'file-edit';
  return 'generic-tool';
}

/** One-line label for a tool's input, without ever dumping a whole payload. */
function describeToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const value = rec[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return '';
}

export function foldSessionEvents(
  events: ReadonlyArray<SessionEvent>,
  options: FoldOptions = {},
): TranscriptState {
  const startedAt = Date.parse(options.startedAt ?? DEFAULT_STARTED_AT);
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  const at = (index: number): string => new Date(startedAt + index * stepMs).toISOString();

  const messages: WsMessage[] = [];
  const activity: WsActivityItem[] = [];
  const pending: PendingCard[] = [];

  // Open streaming assistant rows, keyed by owning tool use so a sub-agent's
  // text coalesces into its OWN row instead of being spliced into the
  // top-level answer. '@root' is the session's own turn.
  const streamingByParent = new Map<string, WsMessage>();
  const rootKey = '@root';
  const key = (parentToolUseId?: string): string => parentToolUseId ?? rootKey;

  // Tool rows are mutated in place: one action is one row that moves through
  // executing → done/failed.
  const toolRows = new Map<string, WsActivityItem>();

  // Thinking coalesces into ONE quiet row per turn.
  let thoughtRow: WsActivityItem | null = null;
  let turnIndex = 0;

  const pushSystem = (index: number, body: string): void => {
    messages.push({
      id: `sys-${index}`,
      kind: 'system',
      authorUid: SESSION_AGENT_UID,
      body,
      createdAt: at(index),
    });
  };

  events.forEach((event, index) => {
    switch (event.kind) {
      case 'started': {
        pushSystem(
          index,
          `Started ${event.tool} (${event.model}) in ${event.cwd} — ${event.tools.length} tools, ${event.commands.length} commands.`,
        );
        break;
      }

      case 'textDelta': {
        const k = key(event.parentToolUseId);
        const open = streamingByParent.get(k);
        if (open) {
          open.body += event.text;
        } else {
          const row: WsMessage = {
            id: `msg-${index}`,
            kind: 'message',
            authorUid: SESSION_AGENT_UID,
            body: event.text,
            createdAt: at(index),
            streaming: true,
          };
          streamingByParent.set(k, row);
          messages.push(row);
        }
        break;
      }

      case 'assistantMessage': {
        const k = key(event.parentToolUseId);
        const open = streamingByParent.get(k);
        if (open) {
          // The finalized text is authoritative — the deltas were a preview of
          // exactly this string, so it replaces rather than appends.
          open.body = event.text;
          open.streaming = false;
          streamingByParent.delete(k);
        } else {
          messages.push({
            id: `msg-${index}`,
            kind: 'message',
            authorUid: SESSION_AGENT_UID,
            body: event.text,
            createdAt: at(index),
          });
        }
        break;
      }

      case 'thinkingDelta': {
        if (thoughtRow) {
          thoughtRow.detail = `${thoughtRow.detail ?? ''}${event.text}`;
        } else {
          thoughtRow = {
            id: `thought-${turnIndex}`,
            cls: 'thought',
            status: 'done',
            agentUid: SESSION_AGENT_UID,
            verb: 'Thought',
            object: 'about the request',
            detail: event.text,
            createdAt: at(index),
          };
          activity.push(thoughtRow);
        }
        break;
      }

      case 'toolCall': {
        const row: WsActivityItem = {
          id: `tool-${event.id}`,
          cls: activityClassForTool(event.name),
          status: 'executing',
          agentUid: SESSION_AGENT_UID,
          verb: 'Ran',
          object: describeToolInput(event.input) || event.name,
          detail: event.name,
          createdAt: at(index),
        };
        toolRows.set(event.id, row);
        activity.push(row);
        break;
      }

      case 'toolResult': {
        const row = toolRows.get(event.id);
        if (row) {
          row.status = event.isError ? 'failed' : 'done';
          row.outcome = event.content;
        } else {
          // A result with no call in this window (a truncated head, say) still
          // deserves a row rather than silent loss.
          activity.push({
            id: `tool-${event.id}`,
            cls: 'generic-tool',
            status: event.isError ? 'failed' : 'done',
            agentUid: SESSION_AGENT_UID,
            verb: 'Ran',
            object: event.id,
            outcome: event.content,
            createdAt: at(index),
          });
        }
        break;
      }

      case 'permissionRequest': {
        const activityId = `perm-${event.requestId}`;
        activity.push({
          id: activityId,
          cls: 'permission',
          status: 'waiting-approval',
          agentUid: SESSION_AGENT_UID,
          verb: 'Needs approval to run',
          object: describeToolInput(event.input) || event.toolName,
          detail: event.toolName,
          createdAt: at(index),
        });
        pending.push({
          type: 'permission',
          requestId: event.requestId,
          toolName: event.toolName,
          input: event.input,
          suggestions: event.suggestions,
          activityId,
        });
        break;
      }

      case 'questionRequest': {
        pending.push({
          type: 'question',
          requestId: event.requestId,
          questions: event.questions,
        });
        break;
      }

      case 'usage': {
        const parts = [`${event.inputTokens} in`, `${event.outputTokens} out`];
        if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
        if (event.durationMs !== undefined) parts.push(`${event.durationMs} ms`);
        activity.push({
          id: `usage-${index}`,
          cls: 'tool-status',
          status: 'done',
          agentUid: SESSION_AGENT_UID,
          verb: 'Used',
          object: 'tokens',
          outcome: parts.join(' · '),
          createdAt: at(index),
        });
        break;
      }

      case 'rateLimit': {
        pushSystem(
          index,
          event.resetsAt
            ? `Rate limited: ${event.message} (resets ${event.resetsAt})`
            : `Rate limited: ${event.message}`,
        );
        break;
      }

      case 'truncated': {
        activity.push({
          id: `truncated-${index}`,
          cls: 'suppressed',
          status: 'done',
          agentUid: SESSION_AGENT_UID,
          verb: 'Hid',
          object: `${event.dropped} noisy events`,
          createdAt: at(index),
          suppressedCount: event.dropped,
        });
        break;
      }

      case 'turnDone': {
        // A turn boundary closes anything still open: a stream that never got
        // its final message, and the turn's thought row.
        for (const open of streamingByParent.values()) open.streaming = false;
        streamingByParent.clear();
        thoughtRow = null;
        turnIndex += 1;
        pushSystem(
          index,
          event.status === 'success'
            ? 'Turn complete.'
            : `Turn ${event.status}${event.error ? `: ${event.error}` : ''}.`,
        );
        break;
      }

      case 'error': {
        pushSystem(index, event.code ? `Error (${event.code}): ${event.message}` : `Error: ${event.message}`);
        break;
      }

      case 'exited': {
        const how =
          event.signal !== undefined
            ? `signal ${event.signal}`
            : event.code !== undefined
              ? `code ${event.code}`
              : 'unknown status';
        pushSystem(index, `Session exited (${how}).`);
        break;
      }
    }
  });

  return { messages, activity, pending };
}
