// Agent "thinking" indicator — thin re-export.
//
// The shared source of truth lives in @hq/ui (packages/ui/src/chat/
// agent-thinking.ts) so the LIVE desktop shell (DesktopApp / ReplyPanel) and
// this classic messaging surface (ChannelView / ThreadPanel) stay in lockstep.
// (`isAgentUid` is not re-exported: the @hq/ui barrel resolves that name to
// the mesh-overlay helper; nothing in apps/sync consumes it.)
export {
  detectAgentMentions,
  startThinking,
  tick,
  clearForAgents,
  labelFor,
  type MentionCandidate,
  type ThinkingPhase,
  type ThinkingEntry,
  type TickOpts,
} from '@hq/ui';
