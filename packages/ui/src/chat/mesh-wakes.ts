/**
 * Map MeshClient reconcile / MQTT payloads onto the chat wake bus.
 * Shared by web and desktop hosts so `type:"thread"` is always `reply:new`.
 */
import {
  channelWakeFromPayload,
  mqttPayloadToText,
  parseDmDeliveredWake,
  parseReplyThreadWake,
  type ReconcileResult,
  type ReplyThreadWakeIds,
} from "@hq/core";

import { createChatWakeBus, type ReplyNewWake } from "./chat-api.js";

export type ChatMeshWakeBus = ReturnType<typeof createChatWakeBus>;

export function toReplyNewWake(ids: ReplyThreadWakeIds): ReplyNewWake {
  return {
    rootEventId: ids.rootEventId,
    eventId: ids.eventId,
    scope: ids.scope,
    ...(ids.channelId ? { channelId: ids.channelId } : {}),
    ...(ids.withPersonUid ? { withPersonUid: ids.withPersonUid } : {}),
  };
}

/**
 * Map an hq-pro MQTT payload onto the chat bus. `type:"thread"` becomes
 * `reply:new` (ids only) and must not also fire `channel:new-message`.
 */
export function routeMeshWake(
  payload: unknown,
  wakes: ChatMeshWakeBus,
): "reply" | "channel" | "dm" | null {
  const reply = routeReplyWake(payload, wakes);
  if (reply) return "reply";
  const text =
    typeof payload === "string"
      ? payload
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? JSON.stringify(payload)
        : mqttPayloadToText(payload);
  const channel = channelWakeFromPayload(text || undefined);
  if (channel) {
    wakes.emit("channel:new-message", channel);
    return "channel";
  }
  const dm = parseDmDeliveredWake(payload ?? text);
  if (!dm || dm.direction === "out") return null;
  wakes.emit("dm:new-message", dm);
  return "dm";
}

/** Alias kept for callers that named the MQTT-only helper. */
export function routeReplyWake(
  payload: unknown,
  wakes: ChatMeshWakeBus,
): "reply" | null {
  const ids = parseReplyThreadWake(payload);
  if (!ids) return null;
  wakes.emit("reply:new", toReplyNewWake(ids));
  return "reply";
}

export function routeMeshReconcile(
  result: ReconcileResult,
  wakes: ChatMeshWakeBus,
): "notifications" | "dm" | "directory" | "reply" {
  if (result.replyWake || result.resource.startsWith("reply:")) {
    if (result.replyWake) {
      wakes.emit("reply:new", toReplyNewWake(result.replyWake));
    }
    return "reply";
  }
  if (result.resource.startsWith("notifications:")) return "notifications";
  if (result.resource.startsWith("dm:")) {
    wakes.emit("dm:pair-unreads", (result.state ?? {}) as never);
    return "dm";
  }
  wakes.emit("channel:unread-changed", undefined);
  return "directory";
}
