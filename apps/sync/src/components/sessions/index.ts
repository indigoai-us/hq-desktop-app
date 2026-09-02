// Session transcript component cluster.
//
// Presentation-pure: every component here takes props and emits callbacks. No
// route, page, or store is wired to them yet — this barrel is the seam a later
// step mounts against.

export { default as ActivityRow } from './ActivityRow.svelte';
export { default as AgentBadge } from './AgentBadge.svelte';
export { default as Avatar } from './Avatar.svelte';
export { default as DayDivider } from './DayDivider.svelte';
export { default as MessageRow } from './MessageRow.svelte';
export { default as MessageTimeline } from './MessageTimeline.svelte';
export { default as Skeleton } from './Skeleton.svelte';
export { default as SystemMessageRow } from './SystemMessageRow.svelte';
export { default as TimelineSkeleton } from './TimelineSkeleton.svelte';
export { default as TypingIndicatorRow } from './TypingIndicatorRow.svelte';
export { default as UnreadDivider } from './UnreadDivider.svelte';

export {
  WS_ACTIVITY_CLASSES,
  WS_ACTIVITY_STATUSES,
  WS_SCREEN_STATES,
  buildTimelineItems,
  formatDayLabel,
  formatFileSize,
  formatTime,
  initials,
} from './session-types';
export type {
  WsActivityClass,
  WsActivityItem,
  WsActivityStatus,
  WsAgentRuntime,
  WsAttachment,
  WsMember,
  WsMemberKind,
  WsMessage,
  WsPresence,
  WsReaction,
  WsScreenState,
  WsTimelineActivity,
  WsTimelineItem,
} from './session-types';

export { SESSION_EVENT_KINDS } from './session-events';
export type {
  AssistantMessageEvent,
  ErrorEvent,
  ExitedEvent,
  PermissionRequestEvent,
  PermissionSuggestion,
  QuestionOption,
  QuestionRequestEvent,
  RateLimitEvent,
  SessionCommand,
  SessionEvent,
  SessionEventKind,
  SessionQuestion,
  StartedEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallEvent,
  ToolResultEvent,
  TruncatedEvent,
  TurnDoneEvent,
  TurnStatus,
  UsageEvent,
} from './session-events';

export {
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  activityClassForTool,
  foldSessionEvents,
} from './transcript-adapter';
export type { FoldOptions, PendingCard, TranscriptState } from './transcript-adapter';
