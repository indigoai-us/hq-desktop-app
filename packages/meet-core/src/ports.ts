/**
 * Injectable ports for the session-owned call engine.
 *
 * Nothing in this package touches the DOM, `window`, Tauri, or the network.
 * Everything the engine needs from the outside world arrives through the
 * structural interfaces below, so the unit tests drive the whole engine with
 * fakes and a deterministic clock, and the Desktop call window (US-016/US-017)
 * supplies the real `RTCPeerConnection`, media tracks and HQ signaling.
 *
 * The WebRTC types are declared structurally rather than imported from
 * `lib.dom` because this package compiles with `types: []` and must stay
 * host-agnostic. A real `RTCPeerConnection` is adapted by the host.
 */

// ---------------------------------------------------------------------------
// Identity and binding
// ---------------------------------------------------------------------------

/** The one call this session is bound to. Explicit - never inferred. */
export interface CallBinding {
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
}

/** A canonical participant: person, device and device public key id. */
export interface PeerIdentity {
  personUid: string;
  deviceId: string;
  peerKey: string;
}

/** Stable, collision-free key for a `PeerIdentity`. */
export function peerIdOf(peer: PeerIdentity): string {
  return `${peer.personUid} ${peer.deviceId} ${peer.peerKey}`;
}

/**
 * Key-free label for snapshots and diagnostics. `peerIdOf` includes the device
 * public key id and stays internal; nothing that leaves the engine carries it.
 */
export function peerLabelOf(peer: PeerIdentity): string {
  return `${peer.personUid} ${peer.deviceId}`;
}

export function sameBinding(a: CallBinding, b: CallBinding): boolean {
  return (
    a.companyUid === b.companyUid &&
    a.roomId === b.roomId &&
    a.callId === b.callId &&
    a.epoch === b.epoch
  );
}

/** The admission grant handed to `join()`; membership comes only from here. */
export interface CallGrant {
  grantId: string;
  role: "host" | "cohost" | "participant";
  rosterRevision: number;
  /** Epoch millis at which the grant stops being valid. */
  expiresAt: number;
  /** Stop sending/receiving traffic this long after control goes quiet. */
  trafficStopMs?: number;
}

// ---------------------------------------------------------------------------
// WebRTC (structural)
// ---------------------------------------------------------------------------

export type PeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export type IceConnectionState =
  | "new"
  | "checking"
  | "connected"
  | "completed"
  | "disconnected"
  | "failed"
  | "closed";

export type PeerSignalingState =
  | "stable"
  | "have-local-offer"
  | "have-remote-offer"
  | "have-local-pranswer"
  | "have-remote-pranswer"
  | "closed";

export interface SessionDescriptionLike {
  type: "offer" | "answer" | "pranswer" | "rollback";
  sdp?: string;
}

export interface IceCandidateLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** A media track the session may attach, replace, and (if it owns it) stop. */
export interface TrackLike {
  readonly id: string;
  readonly kind: string;
  stop(): void;
}

export interface SenderLike {
  readonly track: TrackLike | null;
  replaceTrack(track: TrackLike | null): Promise<void>;
}

/**
 * A control data channel. The HQ Meet signal contract pins `type` to
 * `offer|answer|ice` (hq-pro `contract.ts` @ `signal`), so a moderation
 * message cannot ride the signalling plane without lying about its type.
 * Moderation therefore travels peer-to-peer on a dedicated
 * `hq-meet-control` channel — see `moderation.ts`.
 */
export interface DataChannelLike {
  readonly label: string;
  /** "connecting" | "open" | "closing" | "closed". */
  readonly readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** The subset of `RTCPeerConnection` the transport actually uses. */
export interface PeerConnectionLike {
  onnegotiationneeded: (() => void) | null;
  onicecandidate:
    | ((event: { candidate: IceCandidateLike | null }) => void)
    | null;
  ontrack: ((event: { track: TrackLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  /**
   * Optional: hosts without data channels simply never carry moderation, and
   * the transport degrades to "no control channel" rather than throwing.
   */
  ondatachannel?: ((event: { channel: DataChannelLike }) => void) | null;
  createDataChannel?(
    label: string,
    options?: { ordered?: boolean },
  ): DataChannelLike;
  readonly connectionState: PeerConnectionState;
  readonly iceConnectionState: IceConnectionState;
  readonly signalingState: PeerSignalingState;
  readonly localDescription: SessionDescriptionLike | null;
  readonly remoteDescription: SessionDescriptionLike | null;
  addTrack(track: TrackLike): SenderLike;
  getSenders(): SenderLike[];
  setLocalDescription(description?: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: IceCandidateLike): Promise<void>;
  restartIce(): void;
  close(): void;
}

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PeerConnectionConfig {
  iceServers?: IceServerLike[];
}

/** Builds a fresh connection. Tests inject a fake; the window the real one. */
export interface PeerConnectionFactory {
  create(config: PeerConnectionConfig): PeerConnectionLike;
}

/**
 * Local media. `getUserMedia` lives in the call window, not here: the host
 * hands the session tracks and says whether the session owns their lifetime.
 */
export interface MediaPort {
  /** The tracks to publish now. Called on join, roster change and refresh. */
  localTracks(): TrackLike[];
  /**
   * When true the session stops the tracks on leave/dispose. Hosts that keep a
   * preview running across calls leave this false and stop them themselves.
   */
  readonly ownsTracks?: boolean;
  /**
   * Track kinds the local user has muted. A muted kind is NEVER sent: the
   * transport clears any sender carrying it (`replaceTrack(null)`) and refuses
   * to attach a new one, so the privacy choice survives `replaceTrack`,
   * renegotiation and reconnect rather than being re-applied afterwards.
   */
  mutedKinds?(): readonly string[];
  /** Optional ICE configuration, refreshed per connection. */
  iceServers?(): IceServerLike[];
}

// ---------------------------------------------------------------------------
// Speaking (heuristic)
// ---------------------------------------------------------------------------

/**
 * A local audio-level heuristic. NOT diarization: it says "this track carried
 * energy above a threshold", never "this person spoke". The production
 * implementation is a WebAudio analyser in the call window; tests inject a
 * fake. Everything derived from it must be labelled as a guess.
 */
export interface SpeakingLevelEvent {
  /** Key-free `personUid deviceId` label, or "self". */
  peerId: string;
  /** Normalised 0..1 audio level. */
  level: number;
}

export interface SpeakingPort {
  /** Begin sampling a track. Returns an unobserve function. */
  observe(peerId: string, track: TrackLike): () => void;
  /** Level events. Returns an unsubscribe function. */
  onLevel(listener: (event: SpeakingLevelEvent) => void): () => void;
  /** Release every analyser and listener. Idempotent. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Clock and timers
// ---------------------------------------------------------------------------

export type TimerHandle = unknown;

export interface Clock {
  now(): number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Jitter source; injectable so backoff is deterministic under test. */
export type RandomSource = () => number;

// ---------------------------------------------------------------------------
// Signaling
// ---------------------------------------------------------------------------

export type SignalType = "offer" | "answer" | "ice";

/** A signal received for this device. The port has already routed it to us. */
export interface InboundSignal {
  binding: CallBinding;
  from: PeerIdentity;
  rosterRevision: number;
  sequence: number;
  type: SignalType;
  /** SDP for offer/answer, ICE candidate for ice. Never logged or snapshot. */
  payload: SessionDescriptionLike | IceCandidateLike;
}

export interface OutboundSignal {
  to: PeerIdentity;
  type: SignalType;
  payload: SessionDescriptionLike | IceCandidateLike;
}

/** Roster/grant state as delivered by HQ. The only source of membership. */
export interface RosterUpdate {
  rosterRevision: number;
  /** Every admitted participant, including this device. */
  peers: PeerIdentity[];
  /** Epoch millis the current grant expires at, when known. */
  grantExpiresAt?: number;
  /** Traffic stop deadline in millis when control goes quiet. */
  trafficStopMs?: number;
}

export interface SignalingHandlers {
  onSignal(signal: InboundSignal): void;
  onRoster(roster: RosterUpdate): void;
  /** Transport-level trouble; content-free. */
  onError(code: string, message: string): void;
}

export interface SignalingPort {
  /** Begin delivering signals and roster updates. */
  start(handlers: SignalingHandlers, grant: CallGrant): Promise<void>;
  send(signal: OutboundSignal): Promise<void>;
  /** Stop everything; must be idempotent and release its own timers. */
  stop(): Promise<void>;
}

/** Everything the session needs injected. */
export interface CallSessionPorts {
  signaling: SignalingPort;
  media: MediaPort;
  connections: PeerConnectionFactory;
  clock: Clock;
  timers: Timers;
  random?: RandomSource;
}
