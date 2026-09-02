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
  costUsd?: number;
  durationMs?: number;
}

export interface RateLimitEvent {
  kind: 'rateLimit';
  message: string;
  resetsAt?: string;
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
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | AssistantMessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | PermissionRequestEvent
  | QuestionRequestEvent
  | UsageEvent
  | RateLimitEvent
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
  'textDelta',
  'thinkingDelta',
  'assistantMessage',
  'toolCall',
  'toolResult',
  'permissionRequest',
  'questionRequest',
  'usage',
  'rateLimit',
  'turnDone',
  'error',
  'exited',
  'truncated',
] as const satisfies ReadonlyArray<SessionEventKind>;
