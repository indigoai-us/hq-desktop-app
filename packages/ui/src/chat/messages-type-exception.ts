/**
 * Owner exception (AUDIT-2-06, 2026-10-03): Messages keeps its larger, bolder
 * type. These are the only elements exempt from the console-rail 20/13, max
 * 500 type rule (docs/design-standard-console-rail.md, "Messages type
 * exception"). Type guards read this list; nothing outside it is exempt.
 */
export interface MessagesTypeException {
  /** Path relative to packages/ui/src. */
  file: string;
  selector: string;
  fontSize?: string;
  fontWeight?: string;
}

export const MESSAGES_TYPE_EXCEPTIONS: readonly MessagesTypeException[] = [
  { file: "shell/DesktopApp.svelte", selector: ".channel-title h2", fontSize: "15px", fontWeight: "600" },
  { file: "shell/DesktopApp.svelte", selector: ".channel-header-agent h2", fontSize: "15px", fontWeight: "600" },
  { file: "shell/DesktopApp.svelte", selector: ".channel-sub", fontSize: "12px" },
  { file: "chat/messaging/ChannelConversation.svelte", selector: ".dm-msg-author", fontSize: "14px", fontWeight: "600" },
  { file: "chat/messaging/ChannelConversation.svelte", selector: ".dm-quick-react-btn", fontSize: "12px" },
  { file: "chat/messaging/ChannelConversation.svelte", selector: ".dm-quick-react-more", fontWeight: "600" },
  { file: "chat/messaging/message-row.css", selector: ":root", fontSize: "15px" },
  { file: "chat/messaging/ReplyPanel.svelte", selector: ".reply-title", fontSize: "15px", fontWeight: "700" },
  { file: "chat/messaging/ReplyPanel.svelte", selector: ".reply-sub", fontSize: "12px" },
  { file: "chat/messaging/ReplyPanel.svelte", selector: ".reply-author", fontSize: "14px", fontWeight: "600" },
  { file: "chat/SetupChannelIntro.svelte", selector: ".hero-title", fontSize: "20px", fontWeight: "600" },
  { file: "chat/SetupChannelIntro.svelte", selector: ".setup-elsewhere-title", fontSize: "15px", fontWeight: "600" },
  { file: "chat/SetupChannelIntro.svelte", selector: ".resource-title", fontSize: "13px", fontWeight: "600" },
];
