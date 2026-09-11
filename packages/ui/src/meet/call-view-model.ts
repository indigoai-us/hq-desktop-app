/**
 * The call view's pure layout/roster logic (US-020).
 *
 * Everything the tiles show is derived here from an authoritative meet-core
 * `CallSnapshot`, the local media intent and the room's host/cohost list — so
 * the admission cap, the ordering, the recovery states and the moderation
 * authority are all testable without a DOM, a peer connection or a network.
 *
 * Content-free by construction: person uids and key-free `personUid deviceId`
 * labels only. No SDP, no candidates, no device keys, no device labels.
 */

/** The admission limit: hq-pro `LIMITS.participants`. Never render past it. */
export const CALL_TILE_LIMIT = 8;

export type CallRole = "host" | "cohost" | "participant";

/**
 * The per-tile connection state, as the user reads it. `removed` is distinct
 * from `disconnected`: the roster took the peer out, which is a moderation
 * outcome, not a network problem, and no retry will bring it back.
 */
export type TileConnection =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "removed";

/** Structural subset of `PeerSnapshot`. Keeps this module import-free. */
export interface CallPeerView {
  peerId: string;
  personUid: string;
  deviceId: string;
  status: "connecting" | "connected" | "reconnecting" | "failed";
  connectionState: string;
  restartAttempts: number;
  remoteTrackKinds: readonly string[];
  localTrackKinds?: readonly string[];
}

/** Structural subset of `CallSnapshot`. */
export interface CallSnapshotView {
  self: { personUid: string; deviceId: string };
  admitted: ReadonlyArray<{ personUid: string; deviceId: string }>;
  peers: readonly CallPeerView[];
  rosterRevision: number;
  trafficStopped: boolean;
}

export interface SelfMediaView {
  /** True when the microphone is muted (intent), i.e. nothing is being sent. */
  micMuted: boolean;
  /** True when the camera is off (intent). */
  cameraOff: boolean;
  /** Local audio-level heuristic. Never presented as confirmed diarization. */
  speaking?: boolean;
  /** Own connection state; "connecting" until the session is joined. */
  connection?: TileConnection;
}

export interface CallViewInput {
  snapshot: CallSnapshotView;
  self: SelfMediaView;
  /** The room owner's person uid, from the backend room record. */
  hostPersonUid?: string | null;
  /** Cohost person uids, from the backend room record. */
  cohosts?: readonly string[];
  /** Key-free peer labels currently flagged by the speaking heuristic. */
  speaking?: readonly string[];
  /** Join order as observed by the window: earliest first. */
  joinOrder?: readonly string[];
  /** Display names by person uid. Falls back to the uid. */
  displayName?: (personUid: string) => string;
}

export interface CallTile {
  /** The key-free `personUid deviceId` label. `self` for the own tile. */
  id: string;
  personUid: string;
  deviceId: string;
  label: string;
  self: boolean;
  role: CallRole;
  connection: TileConnection;
  /** True when this tile is known to be sending no audio. */
  micMuted: boolean;
  /** True when this tile is known to be sending no video. */
  cameraOff: boolean;
  /** Heuristic only. Rendered as "may be speaking", never as a fact. */
  maybeSpeaking: boolean;
  /**
   * Content-free recovery guidance, or null when there is nothing to recover.
   * Never an error message from a peer connection.
   */
  recovery: string | null;
}

export interface CallViewLayout {
  tiles: CallTile[];
  /**
   * Admitted participants beyond the render cap. Content-free: a COUNT, never
   * names — nothing about an unrendered participant leaks through the layout.
   */
  overflow: number;
  /** Column count for the gallery grid, 1..4. */
  columns: number;
  /** True when the admission limit is exactly reached. */
  atLimit: boolean;
}

/** Host and cohost may moderate. A participant never can. */
export function canModerate(role: CallRole): boolean {
  return role === "host" || role === "cohost";
}

/** Gallery columns for a tile count, capped at the admission limit. */
export function tileColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

function peerLabel(entry: { personUid: string; deviceId: string }): string {
  return `${entry.personUid} ${entry.deviceId}`;
}

function roleOf(
  personUid: string,
  hostPersonUid: string | null | undefined,
  cohosts: readonly string[],
): CallRole {
  if (hostPersonUid && personUid === hostPersonUid) return "host";
  return cohosts.includes(personUid) ? "cohost" : "participant";
}

/**
 * Map a transport's state to what the user is told, plus a recovery line.
 *
 * `failed` after the engine's restart budget is "disconnected" to a person:
 * the call is trying, and the tile says so rather than showing an RTC term.
 */
function connectionOf(peer: CallPeerView): {
  connection: TileConnection;
  recovery: string | null;
} {
  if (peer.status === "connected") return { connection: "connected", recovery: null };
  if (peer.status === "reconnecting") {
    return {
      connection: "reconnecting",
      recovery: "Reconnecting. Their audio and video will come back on its own.",
    };
  }
  if (peer.status === "failed") {
    return {
      connection: "disconnected",
      recovery:
        "Disconnected. If this does not clear, leave and rejoin the call.",
    };
  }
  return {
    connection: "connecting",
    recovery: peer.restartAttempts > 0 ? "Still trying to connect." : null,
  };
}

/**
 * Derive the whole gallery from one authoritative snapshot.
 *
 * Ordering is stable: self first, then admitted peers by observed join order,
 * then lexically by peer label so a roster that arrives in a different order
 * does not shuffle the grid under the user's cursor.
 *
 * The cap is the ADMISSION limit, applied to what is rendered: a ninth admitted
 * entry is never a tile. It shows up only as an overflow count.
 */
export function deriveCallView(input: CallViewInput): CallViewLayout {
  const { snapshot } = input;
  const cohosts = input.cohosts ?? [];
  const displayName = input.displayName ?? ((personUid: string) => personUid);
  const speaking = new Set(input.speaking ?? []);
  const joinOrder = input.joinOrder ?? [];
  const selfLabel = peerLabel(snapshot.self);

  const byLabel = new Map<string, CallPeerView>();
  for (const peer of snapshot.peers) byLabel.set(peer.peerId, peer);

  // Membership is the ADMITTED roster, not the transports we happen to hold: a
  // participant admitted but not yet connected is a tile that says "connecting",
  // not an absence. Before the first roster (revision 0) we know only ourselves.
  const admitted = snapshot.admitted.filter(
    (entry) => peerLabel(entry) !== selfLabel,
  );

  const ordered = [...admitted].sort((a, b) => {
    const left = peerLabel(a);
    const right = peerLabel(b);
    const li = joinOrder.indexOf(left);
    const ri = joinOrder.indexOf(right);
    if (li !== ri) {
      if (li === -1) return 1;
      if (ri === -1) return -1;
      return li - ri;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const selfTile: CallTile = {
    id: "self",
    personUid: snapshot.self.personUid,
    deviceId: snapshot.self.deviceId,
    label: displayName(snapshot.self.personUid),
    self: true,
    role: roleOf(snapshot.self.personUid, input.hostPersonUid, cohosts),
    connection: snapshot.trafficStopped
      ? "disconnected"
      : (input.self.connection ?? "connected"),
    micMuted: input.self.micMuted,
    cameraOff: input.self.cameraOff,
    // Never flagged while muted: a muted microphone sends nothing, so any
    // level reading is stale by definition.
    maybeSpeaking: !input.self.micMuted && input.self.speaking === true,
    recovery: snapshot.trafficStopped
      ? "The call stopped sending. Reconnecting to the call service."
      : null,
  };

  const tiles: CallTile[] = [selfTile];
  let renderedAdmitted = 0;
  for (const entry of ordered) {
    if (tiles.length >= CALL_TILE_LIMIT) break;
    const label = peerLabel(entry);
    renderedAdmitted += 1;
    const peer = byLabel.get(label);
    const state = peer
      ? connectionOf(peer)
      : { connection: "connecting" as TileConnection, recovery: null };
    tiles.push({
      id: label,
      personUid: entry.personUid,
      deviceId: entry.deviceId,
      label: displayName(entry.personUid),
      self: false,
      role: roleOf(entry.personUid, input.hostPersonUid, cohosts),
      connection: snapshot.trafficStopped ? "disconnected" : state.connection,
      // Known only from what actually arrives: no remote audio track means no
      // audio is being sent. We never claim to know a remote UI's intent.
      micMuted: !peer?.remoteTrackKinds.includes("audio"),
      cameraOff: !peer?.remoteTrackKinds.includes("video"),
      maybeSpeaking: speaking.has(label),
      recovery: state.recovery,
    });
  }

  // Transports for peers the roster no longer admits are a REMOVAL, and the
  // engine has already closed them. They are surfaced (not rendered as live
  // tiles) only when they still fit under the cap, so the removal is visible
  // rather than a tile silently vanishing.
  const admittedLabels = new Set(admitted.map(peerLabel));
  for (const peer of snapshot.peers) {
    if (tiles.length >= CALL_TILE_LIMIT) break;
    if (peer.peerId === selfLabel || admittedLabels.has(peer.peerId)) continue;
    if (snapshot.rosterRevision < 1) continue;
    tiles.push({
      id: peer.peerId,
      personUid: peer.personUid,
      deviceId: peer.deviceId,
      label: displayName(peer.personUid),
      self: false,
      role: roleOf(peer.personUid, input.hostPersonUid, cohosts),
      connection: "removed",
      micMuted: true,
      cameraOff: true,
      maybeSpeaking: false,
      recovery: "Removed from the call.",
    });
  }

  return {
    tiles,
    overflow: Math.max(0, admitted.length - renderedAdmitted),
    columns: tileColumns(tiles.length),
    atLimit: admitted.length + 1 >= CALL_TILE_LIMIT,
  };
}


// ---------------------------------------------------------------------------
// Device selection
// ---------------------------------------------------------------------------

/**
 * One selectable input. `label` is whatever the OS gave us and is rendered but
 * never logged, never put in a snapshot and never sent anywhere: device labels
 * identify hardware, and through it people.
 */
export interface MediaDeviceOption {
  deviceId: string;
  label: string;
  kind: "audioinput" | "videoinput";
}

/**
 * Injected device enumeration. The component never touches
 * `navigator.mediaDevices` itself, so it stays platform-pure and the tests
 * drive real pickers with a fake.
 */
export interface MediaDevicesPort {
  list(): Promise<readonly MediaDeviceOption[]>;
  /** Fires when devices are plugged/unplugged. Returns an unsubscribe. */
  onChange?(listener: () => void): () => void;
}

/** Remembered device CHOICE. Like the mute intent, never a reason to capture. */
export interface DevicePreferences {
  microphoneId: string | null;
  cameraId: string | null;
}

export const DEVICE_PREFS_KEY = "meet.media.devices";

export function emptyDevicePreferences(): DevicePreferences {
  return { microphoneId: null, cameraId: null };
}

/** Parse remembered device ids. Anything unexpected falls back to "default". */
export function parseDevicePreferences(raw: unknown): DevicePreferences {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return emptyDevicePreferences();
    }
  }
  if (!value || typeof value !== "object") return emptyDevicePreferences();
  const record = value as Record<string, unknown>;
  return {
    microphoneId:
      typeof record.microphoneId === "string" ? record.microphoneId : null,
    cameraId: typeof record.cameraId === "string" ? record.cameraId : null,
  };
}

/**
 * Resolve the device to pre-select: the remembered one when it is still
 * present, otherwise the first available. A device that went away must not
 * leave the picker pointing at nothing.
 */
export function resolveDevice(
  remembered: string | null,
  options: readonly MediaDeviceOption[],
): string | null {
  if (options.length === 0) return null;
  if (remembered && options.some((option) => option.deviceId === remembered)) {
    return remembered;
  }
  return options[0]?.deviceId ?? null;
}
