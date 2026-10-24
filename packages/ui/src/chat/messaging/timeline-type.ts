/**
 * Message type of one timeline row, as the desktop conversation pane and the
 * Activity column (US-006) classify it. Lifecycle cards ask the person to act,
 * so they count as people; other system models, work-session (mesh) bodies
 * and flagged rows are system; the rest follows `messageType` without
 * inferring from the sender uid (bot DM replies carry no audience tag).
 */
import { messageType, type MessageType } from "@hq/platform";
import type { ConversationMessageWire } from "../chat-api";
import { systemModelForMessage } from "./channelMessageModels";
import { parseWorkSessionEvent } from "./workSessionEvent";

export function timelineMessageType(msg: ConversationMessageWire): MessageType {
  const model = systemModelForMessage(msg);
  if (model?.kind === "lifecycle_card") return "people";
  if (model !== null) return "system";
  if (parseWorkSessionEvent(msg.body ?? "") !== null) return "system";
  return messageType(msg, { inferFromUid: false });
}
