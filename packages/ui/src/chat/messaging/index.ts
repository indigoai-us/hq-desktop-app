/**
 * Real messaging stack (US-004/US-025), ported faithfully from the hq-sync
 * desktop source and made platform-pure + zero-network for the shared display
 * library. Consumed by the DesktopApp shell in BOTH apps/web and apps/desktop.
 */
export { default as ChannelConversation } from "./ChannelConversation.svelte";
export { default as ReplyPanel } from "./ReplyPanel.svelte";
export { default as AgentThinkingRow } from "./AgentThinkingRow.svelte";
export { default as BoardTab } from "./BoardTab.svelte";
export { default as ChannelFilesTab } from "./ChannelFilesTab.svelte";
export { default as RunCompleteCard } from "./RunCompleteCard.svelte";
export { default as ReactionBar } from "./ReactionBar.svelte";
export { default as EmojiPicker } from "./EmojiPicker.svelte";
export { default as IdentityMark } from "./IdentityMark.svelte";
export * from "./agent-avatars";
export { default as SystemEventLine } from "./SystemEventLine.svelte";
export { default as WorkMeshActivityRow } from "./WorkMeshActivityRow.svelte";
export * from "./workSessionEvent";
export * from "./channelMessageModels";
export * from "./channelTabModels";
export * from "./reactions";
export * from "./conversation-copy";
export * from "./timeline-window";
export { default as PromptAttachment } from "./PromptAttachment.svelte";
export { default as MessageAttachments } from "./MessageAttachments.svelte";
export { default as AttachmentTray } from "./AttachmentTray.svelte";
export { default as AttachmentPreview } from "./AttachmentPreview.svelte";
export * from "./chat-attachments";
export * from "./upload-chat-attachments";
export * from "./composer-send-error";
export * from "./attachment-preview";
export * from "./channel-file-preview";
