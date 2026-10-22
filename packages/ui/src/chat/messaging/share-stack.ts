import type { ConversationMessageWire } from "../chat-api";
import type { FileAttachmentModel } from "./channelMessageModels";
import { parseMessageAttachments } from "./channelMessageModels";

/**
 * Bodies the share and delegate flows send next to a shared vault path. Accepts
 * the bare line ("Shared a file with you.") and the named form hq-pro sends
 * since feedback_7c7daa44 ("Shared a file with you: q3.pdf (in HQ at
 * reports/q3.pdf)." / "Shared 5 files with you: a, b, c and 2 more."). The
 * named form must stay on one line: no control or line/paragraph separator
 * characters after the colon, so text on a later line is never hidden in a
 * stack. Character classes are disjoint, so matching runs in linear time.
 */
const SHARE_BODY =
  /^shared[ \t]+(?:a|an|one|\d+)[ \t]+(?:folder|file|item)(?:\(s\)|s)?[ \t]+with[ \t]+you(?::[ \t]+(\S[^\p{Cc}\p{Zl}\p{Zp}]*))?\.?$/iu;

/** Characters hq-pro replaces with a space in names it puts in a share body. */
const SHARE_NAME_UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** hq-pro cuts names longer than 80 characters to 79 plus an ellipsis. */
const SHARE_NAME_PREFIX_CHARS = 79;

function shareBodyNamePrefix(name: string): string {
  return [...name.replace(SHARE_NAME_UNSAFE, " ")].slice(0, SHARE_NAME_PREFIX_CHARS).join("");
}

/**
 * The named form counts as a plain share only when it starts with the name of
 * something attached (or the root grant), so a one-line note such as "Shared a
 * file with you: please call me first" still renders on its own row.
 */
function namesAnAttachment(named: string, attachments: FileAttachmentModel[]): boolean {
  if (named.startsWith("the whole vault")) return true;
  return attachments.some((item) => {
    const candidates = [item.name, item.vaultPath?.replace(/\/+$/, "").split("/").pop() ?? ""];
    return candidates.some((name) => {
      const prefix = shareBodyNamePrefix(name ?? "");
      return prefix.length > 0 && named.startsWith(prefix);
    });
  });
}

function isShareOnlyBody(body: string, attachments: FileAttachmentModel[]): boolean {
  const match = SHARE_BODY.exec(body);
  if (!match) return false;
  const named = match[1];
  return named === undefined || namesAnAttachment(named, attachments);
}

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
  return body === "" || msg.messageKind === "file_share" || isShareOnlyBody(body, attachments);
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
