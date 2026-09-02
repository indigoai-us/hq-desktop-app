// TypeScript mirror of the Rust session-event enum.
//
// The Rust side is an internally-tagged serde enum (`tag = "kind"`) with
// camelCase variant names and camelCase fields, so a serialized event arrives
// on the wire as e.g. `{ "kind": "textDelta", "text": "…" }`. This module is
// the ONE place that shape is written down on the TypeScript side — the
// transcript adapter folds it, and nothing else re-declares it.
//
// Pure types + a discriminant list + ONE runtime helper (`contentToText`),
// which exists because the wire is not as tidy as the types: several Rust
// fields are `serde_json::Value` (`content`, `input`, `suggestions`) and every
// `Option<_>` arrives as `null`, not `undefined`. Anything that calls a string
// method on an event field goes through `contentToText` first. No I/O.

export interface SessionCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

/**
 * One image riding a user turn (Rust `ImageAttachment`). Raw base64 with NO
 * data-URL prefix — the backend prepends nothing, so a `data:image/png;base64,`
 * head here would be sent to the model as part of the payload.
 */
export interface ImageAttachment {
  mediaType: string;
  base64: string;
}

export interface PermissionSuggestion {
  /** Free-form suggestion payload as the agent host emits it. */
  [key: string]: unknown;
}

export interface QuestionOption {
  label: string;
  /** Rust `Option<String>` — `null` on the wire, never just absent. */
  description?: string | null;
}

export interface SessionQuestion {
  id: string;
  header: string;
  text: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type TurnStatus = 'success' | 'error' | 'interrupted';

export interface StartedEvent {
  kind: 'started';
  sessionId: string;
  tool: string;
  model: string;
  cwd: string;
  tools: string[];
  commands: SessionCommand[];
}

/**
 * A turn the OPERATOR sent, recorded by the backend as it writes the line to
 * the CLI. It is what makes `agent_session_replay` a conversation rather than
 * the agent's half of one.
 *
 * Only the image COUNT crosses the wire — the bytes are never buffered.
 */
export interface UserMessageEvent {
  kind: 'userMessage';
  text: string;
  imageCount: number;
}

export interface TextDeltaEvent {
  kind: 'textDelta';
  text: string;
  parentToolUseId?: string | null;
}

export interface ThinkingDeltaEvent {
  kind: 'thinkingDelta';
  text: string;
}

export interface AssistantMessageEvent {
  kind: 'assistantMessage';
  text: string;
  parentToolUseId?: string | null;
}

export interface ToolCallEvent {
  kind: 'toolCall';
  id: string;
  name: string;
  /** Rust `serde_json::Value` — an object for Claude, but legally anything. */
  input: unknown;
  parentToolUseId?: string | null;
}

/**
 * A tool's result. `content` is a Rust `serde_json::Value`, and on the wire it
 * really is any of: `null` (a Codex command with no output, a Claude result
 * with no `content` key), a string, an array of Claude content blocks
 * (`[{ type: "text", text }]`), or an object (a Codex `fileChange`). It was
 * typed `string` once, and the adapter trusted that — `null.split` took the
 * whole window down. Read it through `contentToText`.
 */
export interface ToolResultEvent {
  kind: 'toolResult';
  id: string;
  isError: boolean;
  content: unknown;
  parentToolUseId?: string | null;
}

export interface PermissionRequestEvent {
  kind: 'permissionRequest';
  requestId: string;
  toolName: string;
  input: unknown;
  /** Rust `serde_json::Value` — usually an array of suggestion objects, but not by contract. */
  suggestions: unknown;
}

export interface QuestionRequestEvent {
  kind: 'questionRequest';
  requestId: string;
  questions: SessionQuestion[];
}

export interface UsageEvent {
  kind: 'usage';
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
  durationMs?: number | null;
}

export interface RateLimitEvent {
  kind: 'rateLimit';
  message: string;
  resetsAt?: string | null;
}

/**
 * A hook in the CLI's host reported text (Rust `HookNotice`) — HQ's policy
 * injection at SessionStart, a checkpoint directive, a blocked tool's reason.
 * Never a transcript row: the adapter folds it into `policies` / checkpoint
 * state. `text` is capped at 8 KB by the backend and otherwise verbatim.
 */
export interface HookNoticeEvent {
  kind: 'hookNotice';
  /** The host's event name: `SessionStart`, `UserPromptSubmit`, Codex `sessionStart`. */
  hookEvent: string;
  /** The host's own id for the hook run (`SessionStart:startup`). */
  hookName: string;
  text: string;
}

export interface TurnDoneEvent {
  kind: 'turnDone';
  status: TurnStatus;
  error?: string | null;
  sessionId?: string | null;
}

export interface ErrorEvent {
  kind: 'error';
  message: string;
  code?: string | null;
}

export interface ExitedEvent {
  kind: 'exited';
  code?: number | null;
  /** Rust `Option<i32>` — a signal NUMBER, `null` when the exit was not a signal. */
  signal?: number | string | null;
}

export interface TruncatedEvent {
  kind: 'truncated';
  dropped: number;
}

export type SessionEvent =
  | StartedEvent
  | UserMessageEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | QuestionRequestEvent
  | UsageEvent
  | RateLimitEvent
  | HookNoticeEvent
  | TurnDoneEvent
  | ErrorEvent
  | ExitedEvent
  | TruncatedEvent;

export type SessionEventKind = SessionEvent['kind'];

/**
 * Every discriminant, as a runtime-readable tuple. Declared once so a test can
 * assert the adapter handles the full enum without restating the vocabulary.
 */
export const SESSION_EVENT_KINDS = [
  'started',
  'userMessage',
  'textDelta',
  'thinkingDelta',
  'assistantMessage',
  'toolCall',
  'toolResult',
  'permissionRequest',
  'questionRequest',
  'usage',
  'rateLimit',
  'hookNotice',
  'turnDone',
  'error',
  'exited',
  'truncated',
] as const satisfies ReadonlyArray<SessionEventKind>;

// ---------------------------------------------------------------------------
// contentToText — the one way a payload becomes a string
// ---------------------------------------------------------------------------

/** Longest JSON rendering of a non-text payload, in characters. */
export const CONTENT_TEXT_CAP = 4096;

function isTextBlock(value: unknown): value is { type: 'text'; text: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'text' &&
    'text' in (value as object)
  );
}

function compactJson(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? '';
  } catch {
    // A cycle or a BigInt — the payload is still not allowed to be a crash.
    json = String(value);
  }
  return json.length > CONTENT_TEXT_CAP ? `${json.slice(0, CONTENT_TEXT_CAP)}…` : json;
}

/**
 * Whatever an event field turned out to be, as the string the UI shows.
 *
 *   - `null` / `undefined` → `''` (the common case: a command with no output)
 *   - a string → itself, verbatim
 *   - an array of Claude text blocks (`[{ type: "text", text }]`) or of plain
 *     strings → the texts joined with newlines
 *   - any other array or object → compact JSON, capped at `CONTENT_TEXT_CAP`
 *   - a number / boolean → its `String`
 *
 * Never throws. This is what every `.split` / `.slice` / `.trim` /
 * `.startsWith` on an event field reads, so a payload the types did not
 * anticipate degrades to text rather than to a blank window.
 */
export function contentToText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean' || typeof content === 'bigint') {
    return String(content);
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') texts.push(item);
      else if (isTextBlock(item)) texts.push(contentToText(item.text));
      else return compactJson(content);
    }
    return texts.join('\n');
  }
  if (typeof content === 'object') return compactJson(content);
  return '';
}
