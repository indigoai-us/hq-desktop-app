export { default as Button } from "./Button.svelte";
export { classNames } from "./class-names.js";

// HQ first-run installer (ported from hq-desktop-app onboarding).
export * from "./onboarding/index.js";

// Chat shell (US-007, ported from desktop-alt)
export { default as ChatSidebar } from "./chat/ChatSidebar.svelte";
export { default as ChannelStatusPopover } from "./chat/ChannelStatusPopover.svelte";
export { default as ConversationView } from "./chat/ConversationView.svelte";
export { default as AgencyChatPanel } from "./chat/AgencyChatPanel.svelte";

// Real messaging stack (faithful port of MessagesShell/ChannelView/Conversation
// leaf components — RunCompleteCard, ReactionBar, IdentityMark, SystemEventLine
// — composed as a fixture-driven, ZERO-NETWORK ChannelConversation).
export * from "./chat/messaging/index.js";
export * from "./chat/chat-api.js";
export * from "./chat/mesh-wakes.js";
export * from "./chat/live-directory.js";
export * from "./chat/live-messages.js";
export * from "./chat/live-catchup.js";
export * from "./chat/reply-layout.js";
export * from "./chat/channels.js";
export * from "./chat/setup-channel.js";
// Agent "thinking" indicator state machine. Explicit list: `isAgentUid` is
// intentionally NOT re-exported here — the barrel already ships the
// mesh-overlay `isAgentUid`; import the agent-thinking one from the module
// path directly if the wider `agent_` prefix matters.
export {
  detectAgentMentions,
  startThinking,
  tick,
  clearForAgents,
  clearFromMessages,
  labelFor,
  type MentionCandidate,
  type ThinkingPhase,
  type ThinkingEntry,
  type TickOpts,
} from "./chat/agent-thinking.js";
export * from "./chat/dm-requests.js";
export * from "./chat/workspaces.js";
export * from "./chat/pending-conversation.js";
export * from "./chat/open-target.js";
export * from "./chat/conversation-title.js";
export * from "./chat/channel-admin.js";
export * from "./chat/channel-directory-reconciler.js";
export * from "./chat/sidebar-model.js";
export * from "./chat/create-flow.js";
export * from "./chat/channel-create-scope.js";
export * from "./chat/channel-status-model.js";
export * from "./chat/mentions.js";
export * from "./chat/portfolio-session.js";
export * from "./chat/agency.js";
export {
  agencyStore,
  configureAgencyApi,
  startAgencyStore,
  stopAgencyStore,
  selectAgencyTeam,
  sendAgencyMessage,
  submitAnswer,
  type AgencyApi,
} from "./chat/agency-store.svelte.js";

// Work-mesh Board + project/thread views (US-008, ported from desktop-alt)
export { default as BoardView } from "./board/BoardView.svelte";
export { default as ThreadList } from "./board/ThreadList.svelte";
export { default as ThreadDetail } from "./board/ThreadDetail.svelte";
export { default as DroppedCompaniesBanner } from "./board/DroppedCompaniesBanner.svelte";
export * from "./board/board-model.js";
export * from "./board/thread-model.js";
export * from "./board/board-api.js";
export * from "./board/board-reconcile.js";
export * from "./board/work-session-feed.js";
export * from "./board/company-scopes.js";

// Identity seam (platform-pure): self-identity "you" tagging + admin gate +
// company-scope precedence (memberships > overlay > empty).
export {
  isSelf,
  selfIsAdmin,
  toSelfIdentity,
  resolveShellCompanies,
  accountChromeFromSelf,
  settingsProfileFromSelf,
  type SelfIdentity,
  type AccountChrome,
  type SettingsProfileChrome,
  type ResolveShellCompaniesInput,
} from "./identity/self.js";
export { createTenantStorage } from "./identity/tenant-storage.js";

export {
  readSettingsPrefs,
  writeSettingsPrefs,
} from "./settings/settings-prefs.js";
export * from "./avatars/index.js";

// V2 windowed desktop shell — composes the title bar + channel rail + views.
export { default as LinkContextMenu } from "./common/LinkContextMenu.svelte";
export * from "./common/external-links.js";

export { default as DesktopApp } from "./shell/DesktopApp.svelte";
export * from "./shell/embedded-navigation.js";
export {
  updateStore,
  checkDesktopUpdates,
  downloadDesktopUpdate,
  restartToUpdate,
  hydrateDownloadedUpdate,
  resetUpdateStore,
  reportDownloadProgress,
  markDownloaded,
  markInstallStarted,
  reportInstallFailed,
  applyAvailableUpdate,
} from "./settings/update-store.svelte.js";

// Work-mesh cache overlay glue (shared by desktop Rust reader + web Node reader).
export * from "./shell/mesh-overlay.js";
export {
  FIXTURE_COMPANIES,
  FIXTURE_INITIAL_ROW,
  FIXTURE_PINS,
  FIXTURE_SEARCH_ROWS,
  FIXTURE_SETTINGS_PROFILE,
  createFixtureChatSidebarApi,
  createFixtureConversationApi,
  createFixtureNotificationsApi,
  fixtureBoardFor,
  fixtureChannelStatusFor,
  fixtureFilesFor,
  fixtureMessagesFor,
  fixtureReactionsFor,
  seedFixturePins,
} from "./shell/fixtures.js";

// Inbox / notifications (US-007)
export { default as NotificationsView } from "./inbox/NotificationsView.svelte";
export * from "./inbox/notifications-model.js";
export * from "./inbox/notification-groups.js";
export * from "./inbox/live-notifications.js";

// Wave 3 (US-010): remaining desktop-alt screens, area barrels.
export * as common from "./common/index.js";
export * as settingsArea from "./settings/index.js";
export * as meetings from "./meetings/index.js";
export * as company from "./company/index.js";
export {
  buildCompanyDisplayMap,
  companyDisplayName,
  looksLikeCompanyUid,
  membershipRowsFrom,
  workspacesFromMembershipRows,
} from "./company/company-display-map.js";
export * as agency from "./agency/index.js";
export * as files from "./files/index.js";
export * as library from "./library/index.js";
export * from "./library/packages-events.js";
export * from "./library/packages-model.js";
export * as marketplace from "./marketplace/index.js";
export * as projects from "./projects/index.js";
export * as home from "./home/index.js";
export {
  PACK_DISPLAY_NAMES,
  packDisplayName,
  prettifyPackName,
} from "./home/pack-display-name.js";
export * as sessions from "./sessions/index.js";
