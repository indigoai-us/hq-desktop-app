/**
 * Deterministic fakes for the injectable ports.
 *
 * Exported from the package (not only the test files) so the acceptance-test
 * writer for US-015 and the call window's own tests drive the same seams: a
 * manual clock, a manual timer queue, a scriptable RTCPeerConnection and an
 * in-memory signaling fabric that can carry two sessions at once.
 */

import type {
  CallBinding,
  CallGrant,
  Clock,
  IceCandidateLike,
  IceConnectionState,
  InboundSignal,
  MediaPort,
  OutboundSignal,
  PeerConnectionConfig,
  PeerConnectionFactory,
  PeerConnectionLike,
  PeerConnectionState,
  PeerIdentity,
  PeerSignalingState,
  RosterUpdate,
  SenderLike,
  SessionDescriptionLike,
  SignalingHandlers,
  SignalingPort,
  TimerHandle,
  Timers,
  TrackLike,
} from "./ports.js";
import { peerIdOf } from "./ports.js";

// ---------------------------------------------------------------------------
// Clock + timers
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** A clock and timer queue driven entirely by `advance()`. */
export class FakeScheduler implements Clock, Timers {
  private current: number;
  private nextId = 1;
  private queue: ScheduledTimer[] = [];

  constructor(start = 1_700_000_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const timer: ScheduledTimer = {
      id: this.nextId,
      at: this.current + Math.max(0, ms),
      fn,
    };
    this.nextId += 1;
    this.queue.push(timer);
    return timer.id;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle !== "number") return;
    this.queue = this.queue.filter((timer) => timer.id !== handle);
  }

  /** Number of timers still armed - the disposal leak check. */
  get pending(): number {
    return this.queue.length;
  }

  /** Run every timer due within `ms`, in due order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.queue
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.queue = this.queue.filter((timer) => timer.id !== due.id);
      this.current = due.at;
      due.fn();
    }
    this.current = target;
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export class FakeTrack implements TrackLike {
  stopped = false;

  constructor(
    readonly id: string,
    readonly kind: string,
  ) {}

  stop(): void {
    this.stopped = true;
  }
}

export class FakeMediaPort implements MediaPort {
  constructor(
    public tracks: TrackLike[] = [],
    readonly ownsTracks = true,
  ) {}

  localTracks(): TrackLike[] {
    return this.tracks;
  }
}

// ---------------------------------------------------------------------------
// Peer connection
// ---------------------------------------------------------------------------

class FakeSender implements SenderLike {
  constructor(public track: TrackLike | null) {}

  async replaceTrack(track: TrackLike | null): Promise<void> {
    this.track = track;
  }
}

/**
 * A scriptable `RTCPeerConnection`. `setLocalDescription()` produces an offer
 * when signaling is stable and an answer when a remote offer is pending, which
 * is exactly the implicit-rollback behaviour perfect negotiation relies on.
 */
export class FakePeerConnection implements PeerConnectionLike {
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate:
    | ((event: { candidate: IceCandidateLike | null }) => void)
    | null = null;
  ontrack: ((event: { track: TrackLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  connectionState: PeerConnectionState = "new";
  iceConnectionState: IceConnectionState = "new";
  signalingState: PeerSignalingState = "stable";
  localDescription: SessionDescriptionLike | null = null;
  remoteDescription: SessionDescriptionLike | null = null;

  closed = false;
  restarts = 0;
  readonly addedCandidates: IceCandidateLike[] = [];
  private senders: FakeSender[] = [];
  private counter = 0;

  constructor(readonly config: PeerConnectionConfig) {}

  addTrack(track: TrackLike): SenderLike {
    const sender = new FakeSender(track);
    this.senders.push(sender);
    // Adding a track drives (re)negotiation, as in the real API.
    queueMicrotask(() => this.onnegotiationneeded?.());
    return sender;
  }

  getSenders(): SenderLike[] {
    return [...this.senders];
  }

  async setLocalDescription(
    description?: SessionDescriptionLike,
  ): Promise<void> {
    this.counter += 1;
    if (description) {
      this.localDescription = description;
    } else if (this.signalingState === "have-remote-offer") {
      this.localDescription = { type: "answer", sdp: `answer-${this.counter}` };
    } else {
      this.localDescription = { type: "offer", sdp: `offer-${this.counter}` };
    }
    this.signalingState =
      this.localDescription.type === "offer" ? "have-local-offer" : "stable";
  }

  async setRemoteDescription(
    description: SessionDescriptionLike,
  ): Promise<void> {
    this.remoteDescription = description;
    this.signalingState =
      description.type === "offer" ? "have-remote-offer" : "stable";
  }

  async addIceCandidate(candidate: IceCandidateLike): Promise<void> {
    if (!this.remoteDescription) throw new Error("no remote description");
    this.addedCandidates.push(candidate);
  }

  restartIce(): void {
    this.restarts += 1;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
  }

  // ---- test drivers ----

  emitCandidate(candidate: IceCandidateLike): void {
    this.onicecandidate?.({ candidate });
  }

  emitRemoteTrack(track: TrackLike): void {
    this.ontrack?.({ track });
  }

  setConnectionState(state: PeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  setIceState(state: IceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

export class FakeConnectionFactory implements PeerConnectionFactory {
  readonly created: FakePeerConnection[] = [];

  create(config: PeerConnectionConfig): PeerConnectionLike {
    const pc = new FakePeerConnection(config);
    this.created.push(pc);
    return pc;
  }

  get last(): FakePeerConnection {
    const pc = this.created[this.created.length - 1];
    if (!pc) throw new Error("no connection created");
    return pc;
  }
}

// ---------------------------------------------------------------------------
// Signaling fabric
// ---------------------------------------------------------------------------

interface FabricMember {
  self: PeerIdentity;
  handlers: SignalingHandlers | null;
  running: boolean;
  sequence: number;
}

/**
 * An in-memory signaling fabric: several sessions attach ports to it and it
 * routes signals between the ones it has admitted. Only `admit()` creates
 * membership - delivering a signal never does.
 */
export class FakeSignalingFabric {
  rosterRevision = 1;
  readonly sent: OutboundSignal[] = [];
  private readonly members = new Map<string, FabricMember>();
  private readonly roster = new Map<string, PeerIdentity>();
  /** Signals accepted from senders the fabric has not admitted. */
  readonly forged: OutboundSignal[] = [];

  constructor(readonly binding: CallBinding) {}

  port(self: PeerIdentity): SignalingPort {
    const key = peerIdOf(self);
    const member: FabricMember = {
      self,
      handlers: null,
      running: false,
      sequence: 0,
    };
    this.members.set(key, member);
    const fabric = this;
    return {
      async start(handlers: SignalingHandlers, _grant: CallGrant) {
        member.handlers = handlers;
        member.running = true;
        // Only an actual roster creates membership; an empty fabric says nothing.
        if (fabric.size > 0) fabric.broadcastRoster();
      },
      async send(signal: OutboundSignal) {
        if (!member.running) return;
        fabric.sent.push(signal);
        member.sequence += 1;
        fabric.deliver(member, signal);
      },
      async stop() {
        member.running = false;
        member.handlers = null;
      },
    };
  }

  /** Number of admitted participants. */
  get size(): number {
    return this.roster.size;
  }

  admit(...peers: PeerIdentity[]): void {
    for (const peer of peers) this.roster.set(peerIdOf(peer), peer);
    this.rosterRevision += 1;
    this.broadcastRoster();
  }

  revoke(peer: PeerIdentity): void {
    this.roster.delete(peerIdOf(peer));
    this.rosterRevision += 1;
    this.broadcastRoster();
  }

  rosterUpdate(extra: Partial<RosterUpdate> = {}): RosterUpdate {
    return {
      rosterRevision: this.rosterRevision,
      peers: [...this.roster.values()],
      ...extra,
    };
  }

  broadcastRoster(extra: Partial<RosterUpdate> = {}): void {
    for (const member of this.members.values()) {
      if (member.running) member.handlers?.onRoster(this.rosterUpdate(extra));
    }
  }

  /** Deliver a raw signal to a member, bypassing the fabric's own routing. */
  inject(target: PeerIdentity, signal: InboundSignal): void {
    const member = this.members.get(peerIdOf(target));
    if (member?.running) member.handlers?.onSignal(signal);
  }

  private deliver(from: FabricMember, signal: OutboundSignal): void {
    if (!this.roster.has(peerIdOf(from.self))) {
      this.forged.push(signal);
      return;
    }
    const target = this.members.get(peerIdOf(signal.to));
    if (!target?.running) return;
    target.handlers?.onSignal({
      binding: this.binding,
      from: from.self,
      rosterRevision: this.rosterRevision,
      sequence: from.sequence,
      type: signal.type,
      payload: signal.payload,
    });
  }
}
