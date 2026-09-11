/**
 * `@hq/meet-core` - a framework-independent, session-owned P2P call engine.
 *
 * No DOM, no `window`, no Tauri, no network: the Desktop call window (US-016)
 * mounts a `CallSession` and injects the ports. See PROVENANCE.md for what was
 * ported from the HQ Meet prototype and what authority was deliberately removed.
 */

export * from "./ports.js";
export {
  PeerTransport,
  TRANSPORT_TUNING,
  isPolite,
  type PeerSnapshot,
  type PeerStatus,
  type PeerTransportDeps,
} from "./transport.js";
export {
  createCallSession,
  type CallDiagnostics,
  type CallError,
  type CallErrorEvent,
  type CallPhase,
  type CallSession,
  type CallSessionEvent,
  type CallSessionEvents,
  type CallSessionOptions,
  type CallSnapshot,
  type CallStateEvent,
  type RemoteTrackEvent,
} from "./session.js";
export {
  createHqSignalingPort,
  decodePayload,
  encodePayload,
  type EnvelopeSigner,
  type HqSignalingOptions,
} from "./hq-signaling.js";
export {
  consentAckFields,
  createConsentGate,
  type ConsentAckFields,
  type ConsentGate,
  type ConsentGateOptions,
  type ConsentGateSnapshot,
  type ConsentProofView,
  type ConsentRosterView,
  type ConsentStatus,
} from "./consent-gate.js";
export {
  createContentDeliveryGate,
  type ContentCloseReason,
  type ContentDeliveryGate,
  type ContentGateEvent,
} from "./content-gate.js";
