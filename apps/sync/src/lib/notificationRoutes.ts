/**
 * Map a DM / share / channel notification payload onto the desktop inbox
 * route grammar (`inbox`, `inbox:dm:<personUid>`,
 * `inbox:channel:<channelId>[:<eventId>]`).
 *
 * Used by native notification actions, in-app banner clicks, and the
 * UNUserNotification body-click path (the Rust side mirrors this mapping).
 */

export interface NotificationRoutePayload {
  fromPersonUid?: unknown;
  channelId?: unknown;
  eventId?: unknown;
  issuerUid?: unknown;
  issuerPersonUid?: unknown;
}

function id(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPayload(value: unknown): NotificationRoutePayload {
  if (value && typeof value === 'object') {
    return value as NotificationRoutePayload;
  }
  return {};
}

/** Pure payload → inbox route. Missing ids fall back to a bare `inbox`. */
export function routeForNotificationPayload(payload: unknown): string {
  const data = asPayload(payload);
  const channelId = id(data.channelId);
  const eventId = id(data.eventId);
  const fromPersonUid = id(data.fromPersonUid);
  const issuerUid = id(data.issuerUid) || id(data.issuerPersonUid);

  if (channelId) {
    return eventId
      ? `inbox:channel:${channelId}:${eventId}`
      : `inbox:channel:${channelId}`;
  }
  if (fromPersonUid) return `inbox:dm:${fromPersonUid}`;
  if (issuerUid) return `inbox:dm:${issuerUid}`;
  return 'inbox';
}
