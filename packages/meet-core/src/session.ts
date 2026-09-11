/**
 * `CallSession` - the session-owned P2P call engine.
 *
 * One instance is bound to exactly one (companyUid, roomId, callId, epoch) and
 * one canonical (personUid, deviceId, peerKey). It owns every peer transport,
 * timer, listener and track it creates and releases all of them on
 * `leave()`/`dispose()`.
 *
 * Authority: membership comes only from the admitted roster delivered by the
 * SignalingPort. A signal, a track or any other inbound activity can never
 * create a peer - the HQ Meet prototype's "publishing implies membership" rule
 * (`src/lib/room/manager.ts` @ eaaf1c5, lines ~247 and ~583) is deliberately
 * not ported. See PROVENANCE.md.
 *
 * Staleness: every join bumps a generation counter. Async completions and
 * port callbacks carry the generation they were registered under and are
 * dropped when it no longer matches, so a previous session's events and media
 * cannot leak into a new call. Listeners are never invoked after `dispose()`.
 */

import {
  peerIdOf,
  sameBinding,
  type CallBinding,
  type CallGrant,
  type CallSessionPorts,
  type IceCandidateLike,
  type InboundSignal,
  type OutboundSignal,
  type PeerIdentity,
  type RosterUpdate,
  type SessionDescriptionLike,
  type TimerHandle,
  type TrackLike,
} from "./ports.js";
import { PeerTransport, type PeerSnapshot } from "./transport.js";

export type CallPhase =
  | "idle"
  | "joining"
  | "joined"
  | "leaving"
  | "disposed";

/** Content-free counters. Never SDP, candidates, keys or person content. */
export interface CallDiagnostics {
  /** Inbound signals dropped because their sequence was already applied. */
  duplicateSignal?: number;
  [counter: string]: number | undefined;
}

/** A content-free error surfaced to the host. */
export interface CallError {
  code: string;
  message: string;
  at: number;
}

export interface CallSnapshot {
  sessionId: string;
  generation: number;
  phase: CallPhase;
  binding: CallBinding;
  self: PeerIdentity;
  rosterRevision: number;
  grantId: string | null;
  grantExpiresAt: number | null;
  trafficStopped: boolean;
  /**
   * Every participant the authoritative roster admits, including self —
   * key-free (`personUid`/`deviceId` only). This is the membership downstream
   * gates must reason about: `peers` is only who we currently hold a transport
   * to, which lags admission and omits anyone we have not connected to yet.
   */
  admitted: Array<{ personUid: string; deviceId: string }>;
  peers: PeerSnapshot[];
  errors: CallError[];
  diagnostics: CallDiagnostics;
}

export interface RemoteTrackEvent {
  sessionId: string;
  generation: number;
  peer: PeerIdentity;
  track: TrackLike;
}

export interface CallErrorEvent extends CallError {
  sessionId: string;
  generation: number;
}

export interface CallStateEvent {
  sessionId: string;
  generation: number;
  snapshot: CallSnapshot;
}

export interface CallSessionEvents {
  state: CallStateEvent;
  track: RemoteTrackEvent;
  error: CallErrorEvent;
}

export type CallSessionEvent = keyof CallSessionEvents;

export interface CallSessionOptions {
  binding: CallBinding;
  self: PeerIdentity;
  ports: CallSessionPorts;
  /** Deterministic id in tests; defaults to a clock+counter derived value. */
  sessionId?: string;
  /** Max content-free errors kept in the snapshot. */
  errorLimit?: number;
}

export interface CallSession {
  readonly sessionId: string;
  readonly binding: CallBinding;
  readonly self: PeerIdentity;
  join(grant: CallGrant): Promise<void>;
  leave(): Promise<void>;
  dispose(): Promise<void>;
  snapshot(): CallSnapshot;
  /** Re-read `MediaPort.localTracks()` and push them onto every transport. */
  refreshLocalTracks(): void;
  on<E extends CallSessionEvent>(
    event: E,
    listener: (payload: CallSessionEvents[E]) => void,
  ): () => void;
}

let sessionCounter = 0;

const DEFAULT_ERROR_LIMIT = 20;

class Session implements CallSession {
  readonly sessionId: string;
  readonly binding: CallBinding;
  readonly self: PeerIdentity;

  private readonly ports: CallSessionPorts;
  private readonly errorLimit: number;
  private readonly listeners = new Map<
    CallSessionEvent,
    Set<(payload: never) => void>
  >();

  private phase: CallPhase = "idle";
  private generation = 0;
  private rosterRevision = 0;
  private grant: CallGrant | null = null;
  private grantExpiresAt: number | null = null;
  private trafficStopMs: number | null = null;
  private trafficStopTimer: TimerHandle | undefined;
  private trafficStopped = false;
  private admitted = new Map<string, PeerIdentity>();
  private transports = new Map<string, PeerTransport>();
  private ownedTracks = new Set<TrackLike>();
  /** Highest inbound `sequence` already applied, per sending peer. */
  private lastSequence = new Map<string, number>();
  private errors: CallError[] = [];
  private diagnostics: CallDiagnostics = {};

  constructor(options: CallSessionOptions) {
    this.binding = { ...options.binding };
    this.self = { ...options.self };
    this.ports = options.ports;
    this.errorLimit = options.errorLimit ?? DEFAULT_ERROR_LIMIT;
    sessionCounter += 1;
    this.sessionId =
      options.sessionId ??
      `cs-${options.ports.clock.now().toString(36)}-${sessionCounter}`;
  }

  // ---- lifecycle ----

  async join(grant: CallGrant): Promise<void> {
    if (this.phase === "disposed") {
      throw new Error("CallSession is disposed");
    }
    if (this.phase === "joining" || this.phase === "joined") {
      throw new Error("CallSession is already joined");
    }
    // A rejoin starts a brand-new generation: anything still in flight from the
    // previous one is dropped on arrival rather than applied to this call.
    this.generation += 1;
    const generation = this.generation;

    this.resetCallState();
    this.grant = { ...grant };
    this.rosterRevision = grant.rosterRevision;
    this.grantExpiresAt = grant.expiresAt;
    this.trafficStopMs = grant.trafficStopMs ?? null;
    this.phase = "joining";
    this.emitState();

    try {
      await this.ports.signaling.start(
        {
          onSignal: (signal) => this.onSignal(generation, signal),
          onRoster: (roster) => this.onRoster(generation, roster),
          onError: (code, message) => this.onError(generation, code, message),
        },
        { ...grant },
      );
    } catch (error) {
      if (!this.current(generation)) return;
      // `start()` may already have delivered a roster before rejecting, so
      // transports, timers and owned tracks can exist. Release all of them and
      // the grant before the failure reaches the host.
      await this.teardown();
      this.grant = null;
      this.phase = "idle";
      this.recordError("SIGNALING_START_FAILED", describe(error));
      this.emitState();
      throw error;
    }

    if (!this.current(generation)) return;
    this.phase = "joined";
    this.armTrafficStop();
    this.emitState();
  }

  async leave(): Promise<void> {
    if (this.phase === "disposed" || this.phase === "idle") return;
    this.phase = "leaving";
    this.emitState();
    // Bump first: callbacks racing the teardown are already stale.
    this.generation += 1;
    await this.teardown();
    // `teardown` can race a concurrent dispose; only an unfinished leave resets.
    if ((this.phase as CallPhase) !== "leaving") return;
    this.phase = "idle";
    this.emitState();
  }

  async dispose(): Promise<void> {
    if (this.phase === "disposed") return;
    this.generation += 1;
    await this.teardown();
    this.phase = "disposed";
    // No state event: a disposed session never invokes a listener again.
    this.listeners.clear();
  }

  private async teardown(): Promise<void> {
    this.dropAllTransports();
    this.admitted.clear();
    this.lastSequence.clear();
    this.clearTrafficStop();
    this.releaseOwnedTracks();
    this.grant = null;
    this.grantExpiresAt = null;
    this.trafficStopMs = null;
    this.trafficStopped = false;
    try {
      await this.ports.signaling.stop();
    } catch (error) {
      this.recordError("SIGNALING_STOP_FAILED", describe(error));
    }
  }

  private resetCallState(): void {
    this.dropAllTransports();
    this.admitted.clear();
    this.lastSequence.clear();
    this.errors = [];
    this.diagnostics = {};
    this.trafficStopped = false;
    this.clearTrafficStop();
  }

  private releaseOwnedTracks(): void {
    if (this.ports.media.ownsTracks) {
      for (const track of this.ownedTracks) {
        try {
          track.stop();
        } catch {
          this.count("trackStopFailed");
        }
      }
    }
    this.ownedTracks.clear();
  }

  // ---- media ----

  refreshLocalTracks(): void {
    if (this.phase !== "joined") return;
    for (const transport of this.transports.values()) {
      transport.attachLocalTracks();
    }
    this.emitState();
  }

  private localTracks(): TrackLike[] {
    if (this.trafficStopped) return [];
    const tracks = this.ports.media.localTracks();
    for (const track of tracks) this.ownedTracks.add(track);
    return tracks;
  }

  // ---- admission ----

  private onRoster(generation: number, roster: RosterUpdate): void {
    if (!this.current(generation)) {
      this.count("staleRosterCallback");
      return;
    }
    if (roster.rosterRevision < this.rosterRevision) {
      this.count("rosterRevisionRegressed");
      return;
    }
    this.rosterRevision = roster.rosterRevision;
    if (roster.grantExpiresAt !== undefined) {
      this.grantExpiresAt = roster.grantExpiresAt;
    }
    if (roster.trafficStopMs !== undefined) {
      this.trafficStopMs = roster.trafficStopMs;
    }
    // Control is alive: the traffic-stop deadline restarts from now.
    this.trafficStopped = false;
    this.armTrafficStop();

    const selfId = peerIdOf(this.self);
    const next = new Map<string, PeerIdentity>();
    for (const peer of roster.peers) {
      next.set(peerIdOf(peer), peer);
    }
    if (!next.has(selfId)) {
      // We are not on our own roster: we hold no admission and must not carry
      // connections. This is the revoked/expired path.
      this.count("selfNotAdmitted");
      this.dropAllTransports();
      this.admitted = new Map();
      this.emitState();
      return;
    }
    this.admitted = next;

    // Ghost-tile teardown: a peer that left the roster loses its transport.
    for (const [peerId, transport] of [...this.transports]) {
      if (!next.has(peerId)) {
        transport.close();
        this.transports.delete(peerId);
        this.count("peerRemovedFromRoster");
      }
    }

    if (this.phase === "joining" || this.phase === "joined") {
      for (const [peerId, peer] of next) {
        if (peerId === selfId) continue;
        this.transportFor(peer).connect();
      }
    }
    this.emitState();
  }

  private dropAllTransports(): void {
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
  }

  /**
   * The admission gate. Everything an unadmitted peer sends is dropped here,
   * before negotiation, before any transport exists, and counted content-free.
   */
  private isAdmitted(peer: PeerIdentity): boolean {
    const known = this.admitted.get(peerIdOf(peer));
    return (
      known !== undefined &&
      known.personUid === peer.personUid &&
      known.deviceId === peer.deviceId &&
      known.peerKey === peer.peerKey
    );
  }

  // ---- signaling ----

  private onSignal(generation: number, signal: InboundSignal): void {
    if (!this.current(generation)) {
      this.count("staleSignalCallback");
      return;
    }
    if (this.phase !== "joined" && this.phase !== "joining") {
      this.count("signalOutsideCall");
      return;
    }
    if (!sameBinding(signal.binding, this.binding)) {
      this.count("wrongBinding");
      return;
    }
    if (signal.rosterRevision !== this.rosterRevision) {
      this.count("staleRosterRevision");
      return;
    }
    if (!this.isAdmitted(signal.from)) {
      this.count("unadmittedPeer");
      return;
    }
    if (this.trafficStopped) {
      this.count("trafficStopped");
      return;
    }
    // A redelivered signal (ack loss, duplicate poll) must never be applied
    // twice: a replayed offer would renegotiate a healthy connection.
    const senderId = peerIdOf(signal.from);
    if (signal.sequence >= 0) {
      const seen = this.lastSequence.get(senderId);
      if (seen !== undefined && signal.sequence <= seen) {
        this.count("duplicateSignal");
        return;
      }
      this.lastSequence.set(senderId, signal.sequence);
    }

    const transport = this.transportFor(signal.from);
    const apply =
      signal.type === "ice"
        ? transport.handleCandidate(signal.payload as IceCandidateLike)
        : transport.handleDescription(signal.payload as SessionDescriptionLike);
    void apply
      .then(() => {
        if (!this.current(generation)) return;
        this.emitState();
      })
      .catch((error: unknown) => {
        if (!this.current(generation)) return;
        this.recordError("SIGNAL_APPLY_FAILED", describe(error));
        this.emitState();
      });
  }

  private transportFor(peer: PeerIdentity): PeerTransport {
    const peerId = peerIdOf(peer);
    const existing = this.transports.get(peerId);
    if (existing) return existing;
    const generation = this.generation;
    const transport = new PeerTransport({
      self: this.self,
      remote: peer,
      connections: this.ports.connections,
      timers: this.ports.timers,
      clock: this.ports.clock,
      random: this.ports.random,
      iceServers: this.ports.media.iceServers
        ? () => this.ports.media.iceServers?.() ?? []
        : undefined,
      localTracks: () => (this.current(generation) ? this.localTracks() : []),
      send: (outbound) => this.send(generation, outbound),
      onChange: () => {
        if (this.current(generation)) this.emitState();
      },
      onRemoteTrack: (from, track) => {
        if (!this.current(generation)) return;
        if (!this.isAdmitted(from)) {
          this.count("unadmittedPeer");
          return;
        }
        this.emit("track", {
          sessionId: this.sessionId,
          generation,
          peer: from,
          track,
        });
      },
      count: (counter) => this.count(counter),
    });
    this.transports.set(peerId, transport);
    return transport;
  }

  private send(generation: number, outbound: OutboundSignal): void {
    if (!this.current(generation)) {
      this.count("staleSend");
      return;
    }
    if (this.trafficStopped) {
      this.count("trafficStopped");
      return;
    }
    if (!this.isAdmitted(outbound.to)) {
      this.count("unadmittedPeer");
      return;
    }
    void this.ports.signaling.send(outbound).catch((error: unknown) => {
      if (!this.current(generation)) return;
      this.recordError("SIGNAL_SEND_FAILED", describe(error));
      this.emitState();
    });
  }

  private onError(generation: number, code: string, message: string): void {
    if (!this.current(generation)) {
      this.count("staleErrorCallback");
      return;
    }
    this.recordError(code, message);
    this.emitState();
  }

  // ---- traffic stop ----

  /**
   * Stop traffic when the grant expires or control goes quiet past
   * `trafficStopMs`, whichever is sooner - even if the control plane is
   * unreachable and cannot tell us.
   */
  private armTrafficStop(): void {
    this.clearTrafficStop();
    const now = this.ports.clock.now();
    const deadlines: number[] = [];
    if (this.grantExpiresAt !== null) deadlines.push(this.grantExpiresAt);
    if (this.trafficStopMs !== null) deadlines.push(now + this.trafficStopMs);
    if (deadlines.length === 0) return;
    const deadline = Math.min(...deadlines);
    this.trafficStopTimer = this.ports.timers.setTimeout(
      () => {
        this.trafficStopTimer = undefined;
        if (this.phase !== "joined" && this.phase !== "joining") return;
        this.trafficStopped = true;
        this.count("trafficStop");
        this.dropAllTransports();
        this.recordError("GRANT_EXPIRED", "Admission grant expired.");
        this.emitState();
      },
      Math.max(0, deadline - now),
    );
  }

  private clearTrafficStop(): void {
    if (this.trafficStopTimer !== undefined) {
      this.ports.timers.clearTimeout(this.trafficStopTimer);
      this.trafficStopTimer = undefined;
    }
  }

  // ---- snapshot and events ----

  snapshot(): CallSnapshot {
    return {
      sessionId: this.sessionId,
      generation: this.generation,
      phase: this.phase,
      binding: { ...this.binding },
      self: { ...this.self },
      rosterRevision: this.rosterRevision,
      grantId: this.grant?.grantId ?? null,
      grantExpiresAt: this.grantExpiresAt,
      trafficStopped: this.trafficStopped,
      admitted: [...this.admitted.values()]
        .map(({ personUid, deviceId }) => ({ personUid, deviceId }))
        .sort((a, b) =>
          a.personUid === b.personUid
            ? a.deviceId < b.deviceId
              ? -1
              : a.deviceId > b.deviceId
                ? 1
                : 0
            : a.personUid < b.personUid
              ? -1
              : 1,
        ),
      peers: [...this.transports.values()]
        .map((transport) => transport.snapshot())
        .sort((a, b) => (a.peerId < b.peerId ? -1 : a.peerId > b.peerId ? 1 : 0)),
      errors: this.errors.map((error) => ({ ...error })),
      diagnostics: { ...this.diagnostics },
    };
  }

  on<E extends CallSessionEvent>(
    event: E,
    listener: (payload: CallSessionEvents[E]) => void,
  ): () => void {
    if (this.phase === "disposed") return () => undefined;
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as (payload: never) => void;
    set.add(entry);
    return () => {
      this.listeners.get(event)?.delete(entry);
    };
  }

  private emit<E extends CallSessionEvent>(
    event: E,
    payload: CallSessionEvents[E],
  ): void {
    if (this.phase === "disposed") return;
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (value: CallSessionEvents[E]) => void)(payload);
      } catch {
        this.count("listenerThrew");
      }
    }
  }

  private emitState(): void {
    this.emit("state", {
      sessionId: this.sessionId,
      generation: this.generation,
      snapshot: this.snapshot(),
    });
  }

  private recordError(code: string, message: string): void {
    this.errors.push({ code, message, at: this.ports.clock.now() });
    if (this.errors.length > this.errorLimit) {
      this.errors = this.errors.slice(-this.errorLimit);
    }
    this.emit("error", {
      sessionId: this.sessionId,
      generation: this.generation,
      code,
      message,
      at: this.ports.clock.now(),
    });
  }

  private count(counter: string): void {
    this.diagnostics[counter] = (this.diagnostics[counter] ?? 0) + 1;
  }

  private current(generation: number): boolean {
    return this.phase !== "disposed" && generation === this.generation;
  }
}

/** A bare, code-like token: the only error text allowed through verbatim. */
const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Max length of a code-like token echoed into a snapshot. */
const MAX_CODE_LENGTH = 120;

/**
 * Error text without leaking payloads. Only a bare code-like token survives;
 * anything else (a raw `Error.message` that could carry SDP, a candidate, a
 * key or person content) collapses to a generic string.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const message = error.message;
  if (message.length <= MAX_CODE_LENGTH && CODE_LIKE.test(message)) {
    return message;
  }
  return "Operation failed.";
}

export function createCallSession(options: CallSessionOptions): CallSession {
  return new Session(options);
}
