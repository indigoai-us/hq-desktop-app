/**
 * Channel wakes reuse the person DM topic (`hq/{personUid}/dm`) with
 * `{ type: "channel", channelId, eventId, createdAt, fromPersonUid }`.
 * The MQTT payload is a ROUTING HINT — never applied as timeline state.
 * The client fetches only that channel's CHAN_MSG slice (exclusive `since`)
 * and merges it. It must not treat the shared DM topic as "refetch inbox".
 */

export interface ChannelWakeHint {
  channelId: string;
  eventId?: string;
  createdAt?: string;
  fromPersonUid?: string;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** True when the payload already names the resource to fetch — skip topic routes. */
export function isTargetedMeshWake(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const rec = parsed as { type?: unknown; fromPersonUid?: unknown };
    if (rec.type === "channel" || rec.type === "thread") return true;
    // Ids-only DM doorbell: bump the pair from `fromPersonUid`. Do not treat
    // the shared `hq/{uid}/dm` topic as "GET /v1/notify/dm" (that path is send).
    return rec.type === "dm" && asTrimmedString(rec.fromPersonUid).length > 0;
  } catch {
    return false;
  }
}

/** Ids-only hq-pro `type:"thread"` doorbell. Not a work-mesh thread topic. */
export interface ReplyThreadWakeIds {
  rootEventId: string;
  eventId: string;
  scope: "dm" | "channel";
  channelId?: string;
  withPersonUid?: string;
}

/** Parse hq-pro reply-thread wake. `type:"thread_event"` does not match. */
export function parseReplyThreadWake(raw: unknown): ReplyThreadWakeIds | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as {
    type?: unknown;
    scope?: unknown;
    rootEventId?: unknown;
    eventId?: unknown;
    channelId?: unknown;
    withPersonUid?: unknown;
    counterpartyUid?: unknown;
    fromPersonUid?: unknown;
  };
  if (rec.type !== "thread") return null;
  if (rec.scope !== "dm" && rec.scope !== "channel") return null;
  const rootEventId = asTrimmedString(rec.rootEventId);
  const eventId = asTrimmedString(rec.eventId);
  if (!rootEventId || !eventId) return null;
  const channelId = asTrimmedString(rec.channelId);
  const withPersonUid =
    asTrimmedString(rec.withPersonUid) ||
    asTrimmedString(rec.counterpartyUid) ||
    (rec.scope === "dm" ? asTrimmedString(rec.fromPersonUid) : "");
  return {
    rootEventId,
    eventId,
    scope: rec.scope,
    ...(rec.scope === "channel" && channelId ? { channelId } : {}),
    ...(rec.scope === "dm" && withPersonUid ? { withPersonUid } : {}),
  };
}

/** Ids-only hq-pro `type:"dm"` doorbell on `hq/{you}/dm`. */
export interface DmDeliveredWake {
  fromPersonUid: string;
  eventId?: string;
  createdAt?: string;
  direction?: "in" | "out";
}

/** Parse a delivered-DM wake. `direction:"out"` is sender-side sync — not unread. */
export function parseDmDeliveredWake(raw: unknown): DmDeliveredWake | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as {
    type?: unknown;
    fromPersonUid?: unknown;
    eventId?: unknown;
    createdAt?: unknown;
    direction?: unknown;
  };
  if (rec.type !== "dm") return null;
  const fromPersonUid = asTrimmedString(rec.fromPersonUid);
  if (!fromPersonUid) return null;
  const direction =
    rec.direction === "out" || rec.direction === "in"
      ? rec.direction
      : undefined;
  const eventId = asTrimmedString(rec.eventId);
  const createdAt = asTrimmedString(rec.createdAt);
  return {
    fromPersonUid,
    ...(eventId ? { eventId } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(direction ? { direction } : {}),
  };
}

export function channelWakeFromPayload(
  raw: string | undefined,
): ChannelWakeHint | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const rec = parsed as {
      type?: unknown;
      channelId?: unknown;
      eventId?: unknown;
      createdAt?: unknown;
      fromPersonUid?: unknown;
    };
    if (rec.type !== "channel") return null;
    const channelId = asTrimmedString(rec.channelId);
    if (!channelId) return null;
    const eventId = asTrimmedString(rec.eventId);
    const createdAt = asTrimmedString(rec.createdAt);
    const fromPersonUid = asTrimmedString(rec.fromPersonUid);
    return {
      channelId,
      ...(eventId ? { eventId } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(fromPersonUid ? { fromPersonUid } : {}),
    };
  } catch {
    return null;
  }
}

export function mqttPayloadToText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) {
    return new TextDecoder().decode(payload);
  }
  if (payload == null) return "";
  if (typeof payload === "object" && "toString" in payload) {
    const text = String(payload);
    return text === "[object Object]" ? "" : text;
  }
  return "";
}
