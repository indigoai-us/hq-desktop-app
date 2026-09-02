// Session transcript component cluster.
//
// Presentation-pure: every component here takes props and emits callbacks. No
// route, page, or store is wired to them yet — this barrel is the seam a later
// step mounts against.

export { default as ActivityRow } from './ActivityRow.svelte';
export { default as AgentBadge } from './AgentBadge.svelte';
export { default as Avatar } from './Avatar.svelte';
export { default as DayDivider } from './DayDivider.svelte';
export { default as MentionPicker } from './MentionPicker.svelte';
export { default as MessageRow } from './MessageRow.svelte';
export { default as MessageTimeline } from './MessageTimeline.svelte';
export { default as PermissionCard } from './PermissionCard.svelte';
export { default as QuestionCard } from './QuestionCard.svelte';
export { default as SessionComposer } from './SessionComposer.svelte';
export { default as SessionsStrip } from './SessionsStrip.svelte';
export { default as ToolGroupRow } from './ToolGroupRow.svelte';
export { default as SessionTranscript } from './SessionTranscript.svelte';
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
  ImageAttachment,
  TruncatedEvent,
  TurnDoneEvent,
  TurnStatus,
  UsageEvent,
} from './session-events';

export {
  SESSION_AGENT_UID,
  SESSION_MEMBERS,
  SESSION_SELF_UID,
  TOOL_CATEGORIES,
  describeToolInput,
  foldSessionEvents,
  toolCategory,
  toolGroupSummary,
} from './transcript-adapter';
export type {
  CardResolution,
  ChatBlock,
  FoldOptions,
  PendingCard,
  ToolCallSummary,
  ToolCategory,
  TranscriptState,
  UsageSummary,
  UserTurn,
} from './transcript-adapter';

export {
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  LAST_COMPANY_KEY,
  LAST_EFFORT_KEY,
  LAST_MODEL_KEY,
  pickModel,
  readRemembered,
  readSessionModels,
  remember,
  shortenModelLabel,
} from './session-models';
export type { ComposerImage, EffortOption, SessionModel } from './session-models';

export {
  applySlashCommand,
  filterSlashCommands,
  mergeSlashCommands,
  slashQueryFor,
} from './slash-commands';
export type { SlashQuery } from './slash-commands';

export {
  addMention,
  applyMention,
  deliveryStatusLine,
  draftHasMention,
  filterMentionCandidates,
  loadMentionCandidates,
  mentionQueryAt,
  mentionSummary,
  mentionToken,
  notifyMentions,
  pruneMentions,
  removeMention,
} from './mentions';
export type {
  Mention,
  MentionCandidate,
  MentionDelivery,
  MentionKind,
  MentionQuery,
  NotifyMentionsArgs,
} from './mentions';
