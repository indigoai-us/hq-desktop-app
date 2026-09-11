/**
 * One peer transport: the RTCPeerConnection to a single admitted remote device.
 *
 * Adapted from the HQ Meet prototype `src/lib/p2p/stream.ts` @ eaaf1c5 (see
 * PROVENANCE.md). What was ported: perfect negotiation with the
 * `makingOffer`/`ignoreOffer` guards and polite rollback, the buffered trickle
 * ICE queue, the capped exponential ICE-restart backoff with a disconnect grace
 * period and an establishment watchdog, and the "fresh offer for a dead
 * connection" recreate. What was deliberately dropped: the module-level
 * global connection map (a transport belongs to exactly one session), GossipSub
 * signaling, and any path where receiving traffic implies membership - the
 * owning session decides who exists before a transport is ever created.
 */

import type {
  Clock,
  IceCandidateLike,
  IceServerLike,
  OutboundSignal,
  PeerConnectionFactory,
  PeerConnectionLike,
  PeerConnectionState,
  PeerIdentity,
  RandomSource,
  SenderLike,
  SessionDescriptionLike,
  SignalType,
  TimerHandle,
  Timers,
  TrackLike,
} from "./ports.js";
import { peerIdOf, peerLabelOf } from "./ports.js";

/** App-level status the UI renders, derived from RTC state plus restarts. */
export type PeerStatus = "connecting" | "connected" | "reconnecting" | "failed";

/** Recovery tuning, ported verbatim from the prototype. */
export const TRANSPORT_TUNING = Object.freeze({
  /** Max automatic ICE restarts before the peer is declared failed. */
  maxIceRestarts: 5,
  /** First-restart delay; doubles each attempt. */
  restartBackoffBaseMs: 1_000,
  /** Backoff ceiling between restart attempts. */
  restartBackoffMaxMs: 15_000,
  /** Jitter added on top of the backoff. */
  restartJitterMs: 500,
  /** How long "disconnected" may self-heal before we force recovery. */
  disconnectGraceMs: 5_000,
  /** How long a (re)negotiation may take before it counts as a failed attempt. */
  establishTimeoutMs: 20_000,
  /** Trickle ICE candidate budget per connection (native harness value). */
  candidateBudget: 256,
});

/** Content-free per-peer view. No SDP, no candidates, no keys. */
export interface PeerSnapshot {
  /** `personUid deviceId` - deliberately key-free. */
  peerId: string;
  personUid: string;
  deviceId: string;
  connectionState: PeerConnectionState;
  status: PeerStatus;
  polite: boolean;
  restartAttempts: number;
  /** Kinds of remote tracks received, e.g. ["audio", "video"]. */
  remoteTrackKinds: string[];
  /** Kinds of local tracks attached to this connection. */
  localTrackKinds: string[];
}

export interface PeerTransportDeps {
  self: PeerIdentity;
  remote: PeerIdentity;
  connections: PeerConnectionFactory;
  timers: Timers;
  clock: Clock;
  random?: RandomSource;
  iceServers?: () => IceServerLike[];
  localTracks: () => TrackLike[];
  send: (signal: OutboundSignal) => void;
  onChange: () => void;
  onRemoteTrack: (peer: PeerIdentity, track: TrackLike) => void;
  count: (counter: string) => void;
}

interface RecoveryTimers {
  restart?: TimerHandle;
  grace?: TimerHandle;
  establish?: TimerHandle;
}

/**
 * Polite/impolite is decided deterministically and symmetrically so exactly one
 * side yields on an offer collision: both peers compute the same roles from the
 * lexical order of `personUid deviceId peerKey`.
 */
export function isPolite(self: PeerIdentity, remote: PeerIdentity): boolean {
  return peerIdOf(self) < peerIdOf(remote);
}

export class PeerTransport {
  readonly remote: PeerIdentity;
  readonly peerId: string;
  readonly polite: boolean;

  private readonly deps: PeerTransportDeps;
  private pc: PeerConnectionLike | null = null;
  private timers: RecoveryTimers = {};
  private pendingCandidates: IceCandidateLike[] = [];
  private remoteTrackKinds = new Set<string>();
  private makingOffer = false;
  private ignoreOffer = false;
  private restartAttempts = 0;
  private status: PeerStatus = "connecting";
  private closed = false;
  private candidatesSent = 0;

  constructor(deps: PeerTransportDeps) {
    this.deps = deps;
    this.remote = deps.remote;
    this.peerId = peerIdOf(deps.remote);
    this.polite = isPolite(deps.self, deps.remote);
  }

  snapshot(): PeerSnapshot {
    return {
      peerId: peerLabelOf(this.remote),
      personUid: this.remote.personUid,
      deviceId: this.remote.deviceId,
      connectionState: this.pc?.connectionState ?? "closed",
      status: this.status,
      polite: this.polite,
      restartAttempts: this.restartAttempts,
      remoteTrackKinds: [...this.remoteTrackKinds].sort(),
      localTrackKinds: (this.pc?.getSenders() ?? [])
        .map((sender) => sender.track?.kind)
        .filter((kind): kind is string => typeof kind === "string")
        .sort(),
    };
  }

  /** Ensure a live connection exists and carries the current local tracks. */
  connect(): void {
    if (this.closed) return;
    const state = this.pc?.connectionState;
    if (
      !this.pc ||
      this.status === "failed" ||
      state === "failed" ||
      state === "closed"
    ) {
      // A recreate is a fresh start: the previous connection's recovery budget
      // does not carry over, or the peer would be declared failed immediately.
      this.restartAttempts = 0;
      this.create();
    }
    this.attachLocalTracks();
  }

  /**
   * Push the current local tracks onto the connection. Same-kind senders are
   * replaced (no renegotiation); a brand-new kind is added, which fires
   * negotiationneeded so the media actually reaches the other side.
   */
  attachLocalTracks(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;
    const senders = pc.getSenders();
    for (const track of this.deps.localTracks()) {
      const existing = senders.find((sender) => sender.track?.kind === track.kind);
      if (existing) {
        if (existing.track === track) continue;
        void this.swap(existing, track);
        continue;
      }
      const empty = senders.find((sender) => sender.track === null);
      if (empty) {
        void this.swap(empty, track);
        continue;
      }
      pc.addTrack(track);
    }
    this.deps.onChange();
  }

  private async swap(sender: SenderLike, track: TrackLike): Promise<void> {
    try {
      await sender.replaceTrack(track);
    } catch {
      this.deps.count("trackReplaceFailed");
    }
  }

  /**
   * Perfect negotiation. On a colliding offer the impolite peer ignores it and
   * the polite peer rolls back via setRemoteDescription, so exactly one
   * negotiation survives simultaneous offers.
   */
  async handleDescription(description: SessionDescriptionLike): Promise<void> {
    if (this.closed) return;
    const state = this.pc?.connectionState;
    if (!this.pc) {
      if (description.type !== "offer") {
        this.deps.count("strayAnswer");
        return;
      }
      this.create();
      this.attachLocalTracks();
    } else if (
      description.type === "offer" &&
      (this.status === "failed" || state === "failed" || state === "closed")
    ) {
      // The remote renegotiated from scratch. A dead connection cannot accept a
      // fresh DTLS handshake, so recreate to match.
      this.create();
      this.attachLocalTracks();
    }

    const pc = this.pc;
    if (!pc) return;

    const collision =
      description.type === "offer" &&
      (this.makingOffer || pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) {
      this.deps.count("offerCollisionIgnored");
      return;
    }
    if (collision) this.deps.count("offerCollisionRolledBack");

    await pc.setRemoteDescription(description);
    // The await above yields: a close, a recreate or a roster removal may have
    // replaced this connection while it ran, exactly as in `negotiate()`.
    if (this.closed || this.pc !== pc) return;
    await this.flushCandidates();
    if (this.closed || this.pc !== pc) return;

    if (description.type === "offer") {
      await pc.setLocalDescription();
      const local = pc.localDescription;
      if (!local || this.closed || this.pc !== pc) return;
      this.deps.send({ to: this.remote, type: "answer", payload: local });
    }
  }

  /** Buffer candidates that arrive before the remote description is set. */
  async handleCandidate(candidate: IceCandidateLike): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    if (!pc || !pc.remoteDescription) {
      if (this.pendingCandidates.length >= TRANSPORT_TUNING.candidateBudget) {
        this.deps.count("candidateBudgetExceeded");
        return;
      }
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      if (!this.ignoreOffer) this.deps.count("candidateRejected");
    }
  }

  private async flushCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        this.deps.count("candidateRejected");
      }
    }
  }

  /** Tear down everything this transport owns. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.detach(this.pc);
    this.pc?.close();
    this.pc = null;
    this.pendingCandidates = [];
    this.remoteTrackKinds.clear();
    this.status = "failed";
  }

  // ---- internals ----

  private create(): void {
    this.clearTimers();
    this.detach(this.pc);
    this.pc?.close();
    // Candidates buffered for a previous connection are stale for this one.
    this.pendingCandidates = [];
    this.candidatesSent = 0;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.remoteTrackKinds.clear();

    const iceServers = this.deps.iceServers?.() ?? [];
    const pc = this.deps.connections.create({ iceServers });
    this.pc = pc;
    if (this.status !== "reconnecting") this.status = "connecting";

    pc.onnegotiationneeded = () => {
      void this.negotiate(pc);
    };

    pc.ontrack = (event) => {
      if (this.closed || this.pc !== pc) return;
      this.remoteTrackKinds.add(event.track.kind);
      this.deps.onRemoteTrack(this.remote, event.track);
      this.deps.onChange();
    };

    pc.onicecandidate = (event) => {
      if (this.closed || this.pc !== pc || !event.candidate) return;
      if (this.candidatesSent >= TRANSPORT_TUNING.candidateBudget) {
        this.deps.count("candidateBudgetExceeded");
        return;
      }
      this.candidatesSent += 1;
      this.deps.send({ to: this.remote, type: "ice", payload: event.candidate });
    };

    pc.oniceconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      const state = pc.iceConnectionState;
      if (state === "failed") {
        this.scheduleIceRestart();
      } else if (state === "connected" || state === "completed") {
        this.markHealthy();
      }
    };

    pc.onconnectionstatechange = () => {
      if (this.closed || this.pc !== pc) return;
      switch (pc.connectionState) {
        case "connected":
          this.markHealthy();
          break;
        case "disconnected":
          this.armGrace();
          break;
        case "failed":
          this.scheduleIceRestart();
          break;
        case "closed":
          this.clearTimers();
          break;
        default:
          break;
      }
      this.deps.onChange();
    };

    this.armEstablishWatchdog();
    this.deps.onChange();
  }

  private async negotiate(pc: PeerConnectionLike): Promise<void> {
    if (this.closed || this.pc !== pc) return;
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      const local = pc.localDescription;
      if (!local || this.closed || this.pc !== pc) return;
      this.deps.send({ to: this.remote, type: "offer", payload: local });
    } catch {
      this.deps.count("negotiationFailed");
    } finally {
      this.makingOffer = false;
    }
  }

  private markHealthy(): void {
    this.restartAttempts = 0;
    this.clearTimers();
    this.setStatus("connected");
  }

  private setStatus(status: PeerStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onChange();
  }

  private armGrace(): void {
    if (this.timers.grace) return;
    this.timers.grace = this.deps.timers.setTimeout(() => {
      this.timers.grace = undefined;
      if (this.closed) return;
      if (this.pc?.connectionState === "disconnected") this.scheduleIceRestart();
    }, TRANSPORT_TUNING.disconnectGraceMs);
  }

  /**
   * Signaling loss can strand a connection in "new"/"connecting" forever with no
   * RTC event ever firing; this turns that silence into a recovery attempt.
   */
  private armEstablishWatchdog(): void {
    this.deps.timers.clearTimeout(this.timers.establish);
    this.timers.establish = this.deps.timers.setTimeout(() => {
      this.timers.establish = undefined;
      if (this.closed) return;
      const state = this.pc?.connectionState;
      if (state === "connected" || state === "closed" || !state) return;
      this.scheduleIceRestart();
    }, TRANSPORT_TUNING.establishTimeoutMs);
  }

  private scheduleIceRestart(): void {
    if (this.closed || this.timers.restart) return;
    if (this.restartAttempts >= TRANSPORT_TUNING.maxIceRestarts) {
      this.setStatus("failed");
      return;
    }
    this.setStatus("reconnecting");

    const random = this.deps.random ?? Math.random;
    const delay =
      Math.min(
        TRANSPORT_TUNING.restartBackoffBaseMs * 2 ** this.restartAttempts,
        TRANSPORT_TUNING.restartBackoffMaxMs,
      ) +
      random() * TRANSPORT_TUNING.restartJitterMs;

    this.timers.restart = this.deps.timers.setTimeout(() => {
      this.timers.restart = undefined;
      if (this.closed) return;
      const pc = this.pc;
      if (!pc) return;
      if (pc.connectionState === "closed") return;
      if (pc.connectionState === "connected") return;

      this.restartAttempts += 1;
      this.deps.count("iceRestart");

      if (pc.signalingState !== "stable") {
        // restartIce() mid-negotiation only sets a flag that waits for signaling
        // to return to stable, which never happens when the offer/answer was
        // lost. Renegotiate from scratch, carrying the budget over.
        const attempts = this.restartAttempts;
        this.status = "reconnecting";
        this.create();
        this.restartAttempts = attempts;
        this.attachLocalTracks();
        return;
      }

      pc.restartIce();
      this.armEstablishWatchdog();
    }, delay);
  }

  private clearTimers(): void {
    this.deps.timers.clearTimeout(this.timers.restart);
    this.deps.timers.clearTimeout(this.timers.grace);
    this.deps.timers.clearTimeout(this.timers.establish);
    this.timers = {};
  }

  private detach(pc: PeerConnectionLike | null): void {
    if (!pc) return;
    pc.onnegotiationneeded = null;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
  }
}

/** Convenience for hosts that want the signal type union without the port import. */
export type { SignalType };
