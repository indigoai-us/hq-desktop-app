/**
 * Host moderation messages (US-020).
 *
 * TRANSPORT DECISION. The hq-pro signal contract pins the signalling `type` to
 * `z.enum(["offer", "answer", "ice"])` (`src/meetings/native/contract.ts`), so
 * a moderation payload cannot be delivered over `signaling/send` without
 * mislabelling it as SDP or as an ICE candidate. It therefore travels on a
 * dedicated peer-to-peer `hq-meet-control` `RTCDataChannel` opened by
 * `PeerTransport` — the same connection the media already runs over, so it
 * inherits the admission gate (an unadmitted peer has no transport and thus no
 * channel) and dies with the peer.
 *
 * AUTHORITY. The backend has NO server-side media authority in this contract:
 * `revoke` removes a participant, `end` ends the room, and nothing else can
 * touch another device's microphone. So "host mute" is a REQUEST that the
 * recipient's own client honours:
 *
 *   - `mute-request` is advisory. The UI shows it; the user decides.
 *   - `mute-force` is honoured ONLY when the sender is a host or cohost
 *     according to the RECIPIENT'S own roster view, and it can only ever mute
 *     (stop sending). The recipient keeps a visible control to unmute itself.
 *   - There is NO unmute action, at any authority level. `parseModeration`
 *     refuses every message that is not one of the two mute actions, so a
 *     remote peer has no encoding that could enable a microphone. Rejected
 *     messages are counted content-free in diagnostics.
 */

/** The label of the dedicated control channel. */
export const MODERATION_CHANNEL_LABEL = "hq-meet-control";

/** The ONLY actions that exist. Deliberately no unmute of any kind. */
export const MODERATION_ACTIONS = ["mute-request", "mute-force"] as const;

export type ModerationAction = (typeof MODERATION_ACTIONS)[number];

/** The only media a moderation message may speak about. */
export type ModerationTrack = "audio" | "video";

export interface ModerationMessage {
  kind: "moderation";
  action: ModerationAction;
  track: ModerationTrack;
}

/** Serialise for the control channel. Content-free by construction. */
export function encodeModeration(message: ModerationMessage): string {
  return JSON.stringify({
    kind: "moderation",
    action: message.action,
    track: message.track,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * True when the message is an attempt to ENABLE someone else's media. Kept
 * separate from `parseModeration` so the engine can count the attempt rather
 * than dropping it silently — an unmute attempt is a thing operators must be
 * able to see, and it is never, ever executed.
 */
export function isRemoteEnableAttempt(data: unknown): boolean {
  const record = asRecord(data);
  const action = record?.action;
  if (typeof action !== "string") return false;
  return /unmute|enable|start|resume/i.test(action);
}

/** Parse a control-channel message. Anything else answers null. */
export function parseModeration(data: unknown): ModerationMessage | null {
  const record = asRecord(data);
  if (!record || record.kind !== "moderation") return null;
  const action = record.action;
  const track = record.track;
  if (
    typeof action !== "string" ||
    !(MODERATION_ACTIONS as readonly string[]).includes(action)
  ) {
    return null;
  }
  if (track !== "audio" && track !== "video") return null;
  return {
    kind: "moderation",
    action: action as ModerationAction,
    track,
  };
}
