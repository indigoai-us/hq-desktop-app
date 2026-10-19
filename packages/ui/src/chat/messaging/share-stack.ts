import type { ConversationMessageWire } from "../chat-api";
import type { FileAttachmentModel } from "./channelMessageModels";
import { parseMessageAttachments } from "./channelMessageModels";

/** Bodies the share and delegate flows send next to a shared vault path. */
const SHARE_BODY = /^shared\s+(?:a|an|one|\d+)\s+(?:folder|file|item)(?:\(s\)|s)?\s+with\s+you\.?$/i;

/**
 * A message that only announces a shared file or folder: nothing in it but the
 * share line and its attachments. Anything a reader might act on separately
 * (a prompt, details, rich content, a forward, replies, reactions) keeps the
 * message out of a stack so that content still renders on its own row.
 */
export function isStackableShare(msg: ConversationMessageWire): boolean {
  if (msg.systemEvent || msg.isSystemEvent) return false;
  if (msg.prompt?.trim() || msg.details?.trim()) return false;
  if (msg.richContent != null || msg.forwardedFrom != null) return false;
  if ((msg.replyCount ?? 0) > 0) return false;
  if (Array.isArray(msg.reactions) && msg.reactions.length > 0) return false;
  const attachments = parseMessageAttachments(msg);
  if (attachments.length === 0) return false;
  if (attachments.some((item) => item.kind === "image")) return false;
  const body = (msg.body ?? "").trim();
  return body === "" || msg.messageKind === "file_share" || SHARE_BODY.test(body);
}

function countLabel(n: number, singular: string): string {
  return n === 1 ? `a ${singular}` : `${n} ${singular}s`;
}

/** "Shared 6 folders with you." / "Shared 2 folders and a file with you." */
export function shareStackSummary(attachments: FileAttachmentModel[]): string {
  const folders = attachments.filter((item) => item.kind === "folder").length;
  const files = attachments.length - folders;
  const parts: string[] = [];
  if (folders > 0) parts.push(countLabel(folders, "folder"));
  if (files > 0) parts.push(countLabel(files, "file"));
  return `Shared ${parts.join(" and ")} with you.`;
}

/** Every attachment across the stacked messages, oldest first. */
export function shareStackAttachments(
  messages: ConversationMessageWire[],
): FileAttachmentModel[] {
  return messages.flatMap((msg) => parseMessageAttachments(msg));
}
