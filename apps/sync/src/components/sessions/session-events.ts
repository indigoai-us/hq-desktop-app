// TypeScript mirror of the Rust session-event enum.
//
// The Rust side is an internally-tagged serde enum (`tag = "kind"`) with
// camelCase variant names and camelCase fields, so a serialized event arrives
// on the wire as e.g. `{ "kind": "textDelta", "text": "…" }`. This module is
// the ONE place that shape is written down on the TypeScript side — the
// transcript adapter folds it, and nothing else re-declares it.
//
// Pure types + a discriminant list. No runtime behaviour, no I/O.

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
  description?: string;
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
  parentToolUseId?: string;
}

export interface ThinkingDeltaEvent {
  kind: 'thinkingDelta';
  text: string;
}

export interface AssistantMessageEvent {
  kind: 'assistantMessage';
  text: string;
  parentToolUseId?: string;
}

export interface ToolCallEvent {
  kind: 'toolCall';
  id: string;
  name: string;
  input: unknown;
  parentToolUseId?: string;
}

export interface ToolResultEvent {
  kind: 'toolResult';
  id: string;
  isError: boolean;
  content: string;
  parentToolUseId?: string;
}

export interface PermissionRequestEvent {
  kind: 'permissionRequest';
  requestId: string;
  toolName: string;
  input: unknown;
  suggestions: PermissionSuggestion[];
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
  resetsAt?: string;
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
  error?: string;
  sessionId?: string;
}

export interface ErrorEvent {
  kind: 'error';
  message: string;
  code?: string;
}

export interface ExitedEvent {
  kind: 'exited';
  code?: number;
  signal?: string;
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
