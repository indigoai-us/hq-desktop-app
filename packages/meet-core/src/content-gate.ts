/**
 * The content-delivery gate (US-017).
 *
 * `CallSession` already closes a removed peer's transport the moment the
 * authoritative roster says the peer is gone, and stops *all* traffic at the
 * traffic-stop deadline even when the control plane is unreachable. That
 * handles media and data. It does not, on its own, stop the things built on
 * top of a call: rendered tiles, transcript lines, shared files — none of
 * which exist yet (US-024+), and all of which must be closed by exactly the
 * same authoritative event rather than by their own timers.
 *
 * So this is the seam those features must consult. It is deliberately dumb:
 * a set of peers that are still allowed to receive and contribute content, a
 * global latch for the whole call, and a subscription so a renderer can drop
 * elements synchronously on the closing event. It never re-opens a peer that
 * was removed — a rejoin is a new peer identity (new device key) or a new
 * call epoch, and either way a fresh gate.
 */

export type ContentCloseReason =
  | "peer-removed"
  | "traffic-stopped"
  | "account-changed"
  | "left";

export interface ContentGateEvent {
  /** `personUid deviceId`, the key-free peer label. Null for call-wide. */
  peerId: string | null;
  reason: ContentCloseReason;
}

export interface ContentDeliveryGate {
  /** May content from/to this peer be delivered right now? */
  allows(peerId: string): boolean;
  /** Is the call as a whole still allowed to deliver content? */
  open(): boolean;
  /** Admit peers present on the authoritative roster. Idempotent. */
  admit(peerIds: readonly string[]): void;
  /** Close one peer permanently. Idempotent. */
  closePeer(peerId: string, reason?: ContentCloseReason): void;
  /** Close everything permanently. Idempotent. */
  closeAll(reason: ContentCloseReason): void;
  /** Fires synchronously on every close so renderers can drop elements now. */
  onClose(listener: (event: ContentGateEvent) => void): () => void;
}

export function createContentDeliveryGate(): ContentDeliveryGate {
  const admitted = new Set<string>();
  const closed = new Set<string>();
  const listeners = new Set<(event: ContentGateEvent) => void>();
  let openForCall = true;

  function emit(event: ContentGateEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  return {
    allows: (peerId) =>
      openForCall && admitted.has(peerId) && !closed.has(peerId),
    open: () => openForCall,

    admit(peerIds): void {
      if (!openForCall) return;
      for (const peerId of peerIds) {
        // A peer closed on an authoritative event is never re-admitted.
        if (closed.has(peerId)) continue;
        admitted.add(peerId);
      }
    },

    closePeer(peerId, reason = "peer-removed"): void {
      if (closed.has(peerId)) return;
      closed.add(peerId);
      admitted.delete(peerId);
      emit({ peerId, reason });
    },

    closeAll(reason): void {
      if (!openForCall) return;
      openForCall = false;
      for (const peerId of [...admitted]) {
        closed.add(peerId);
        admitted.delete(peerId);
      }
      emit({ peerId: null, reason });
    },

    onClose(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
