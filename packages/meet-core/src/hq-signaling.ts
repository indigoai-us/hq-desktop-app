/**
 * The production `SignalingPort`: HQ-authorized durable signaling.
 *
 * Sends through `CallsApi.sendSignal` and polls
 * `CallsApi.signalingControl("reconcile")` at the backend's `controlPollMs`,
 * acking delivered signal ids, renewing the grant before `renewAfterMs`, and
 * surfacing the admitted roster. Membership is whatever reconcile says it is:
 * this port never invents a peer from an inbound signal.
 *
 * Envelopes are signed through an injected `EnvelopeSigner`, so the device
 * Ed25519 private key stays in the native host and never enters this package.
 * The host implements it with `@hq/platform`'s `signedBytes` canonicalization.
 *
 * Nothing here logs SDP, candidates or keys.
 */

import type { CallsApi, Json } from "@hq/platform";
import type {
  CallBinding,
  CallGrant,
  IceCandidateLike,
  InboundSignal,
  OutboundSignal,
  PeerIdentity,
  SessionDescriptionLike,
  SignalingHandlers,
  SignalingPort,
  SignalType,
  TimerHandle,
  Timers,
  Clock,
} from "./ports.js";

/** Signs a "hq-meet/1" envelope, returning the base64url Ed25519 signature. */
export interface EnvelopeSigner {
  sign(envelope: Record<string, unknown>): Promise<string>;
}

export interface HqSignalingOptions {
  binding: CallBinding;
  self: PeerIdentity;
  clock: Clock;
  timers: Timers;
  /** Fallback poll interval when the backend does not send `controlPollMs`. */
  defaultPollMs?: number;
  /** Fallback renew threshold when the backend does not send `renewAfterMs`. */
  defaultRenewAfterMs?: number;
  /** Unique request ids; injectable so tests stay deterministic. */
  requestId?: () => string;
}

const VERSION = "hq-meet/1";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_RENEW_AFTER_MS = 30_000;

const B64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 of a UTF-8 string; the contract's `bytes()` shape. */
export function encodePayload(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < bytes.length ? B64[c & 63] : "=";
  }
  return out;
}

export function decodePayload(value: string): unknown {
  const clean = value.replace(/=+$/, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let out = 0;
  for (const char of clean) {
    const index = B64.indexOf(char);
    if (index < 0) throw new Error("INVALID_PAYLOAD");
    acc = (acc << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out] = (acc >> bits) & 0xff;
      out += 1;
    }
  }
  return JSON.parse(new TextDecoder().decode(bytes.subarray(0, out))) as unknown;
}

/** Backend refusals always reach the host with a code and message. */
function refusalCode(code: string | undefined): string {
  return code ?? "SIGNALING_REFUSED";
}

function refusal(message: string | undefined): string {
  return message ?? "The signaling service refused the request.";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identity(value: unknown): PeerIdentity | null {
  const source = record(value);
  if (!source) return null;
  const { personUid, deviceId, peerKey } = source;
  if (
    typeof personUid !== "string" ||
    typeof deviceId !== "string" ||
    typeof peerKey !== "string"
  ) {
    return null;
  }
  return { personUid, deviceId, peerKey };
}

function signalType(value: unknown): SignalType | null {
  return value === "offer" || value === "answer" || value === "ice"
    ? value
    : null;
}

/**
 * Build the HQ signaling port. `callsApi` must already have passed
 * `preflight()`; every call here surfaces a backend refusal as `onError` with
 * the backend's own code, never as a thrown, content-bearing error.
 */
export function createHqSignalingPort(
  callsApi: CallsApi,
  signer: EnvelopeSigner,
  options: HqSignalingOptions,
): SignalingPort {
  const { binding, self, clock, timers } = options;
  const pollMs = options.defaultPollMs ?? DEFAULT_POLL_MS;
  const renewAfterDefault =
    options.defaultRenewAfterMs ?? DEFAULT_RENEW_AFTER_MS;
  let requestCounter = 0;
  const nextRequestId =
    options.requestId ??
    (() => {
      requestCounter += 1;
      return `req-${clock.now().toString(36)}-${requestCounter}`;
    });

  let handlers: SignalingHandlers | null = null;
  let grant: CallGrant | null = null;
  let running = false;
  let pollTimer: TimerHandle | undefined;
  let sequence = 0;
  let rosterRevision = 0;
  let pendingAcks: string[] = [];
  let nextRenewAt = Number.POSITIVE_INFINITY;
  let currentPollMs = pollMs;
  let renewLeadMs = renewAfterDefault;
  let leaseExpiresAt: number | null = null;

  async function control(
    operation: "renew" | "reconcile",
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | null> {
    const envelope: Record<string, unknown> = {
      version: VERSION,
      kind: "control",
      companyUid: binding.companyUid,
      roomId: binding.roomId,
      callId: binding.callId,
      epoch: binding.epoch,
      operation,
      personUid: self.personUid,
      deviceId: self.deviceId,
      peerKey: self.peerKey,
      requestId: nextRequestId(),
      sentAt: clock.now(),
      ...(grant ? { grantId: grant.grantId } : {}),
      ...extra,
    };
    const signature = await signer.sign(envelope);
    const result = await callsApi.signalingControl(operation, {
      ...envelope,
      signature,
    } as Json);
    if (!result.ok) {
      handlers?.onError(refusalCode(result.code), refusal(result.message));
      return null;
    }
    return record(result.value);
  }

  /**
   * Renew when less than `renewAfterMs` of the grant's life is left, measured
   * against the lease expiry the backend reports - never against the last poll,
   * which would push the deadline out forever while the call is healthy.
   */
  function applyTiming(body: Record<string, unknown>): void {
    const poll = body.controlPollMs;
    if (typeof poll === "number" && poll > 0) currentPollMs = poll;
    if (typeof body.renewAfterMs === "number" && body.renewAfterMs >= 0) {
      renewLeadMs = body.renewAfterMs;
    }
    if (typeof body.expiresAt === "number") {
      leaseExpiresAt = body.expiresAt;
    }
    nextRenewAt =
      leaseExpiresAt === null
        ? Number.POSITIVE_INFINITY
        : leaseExpiresAt - renewLeadMs;
  }

  function publishRoster(body: Record<string, unknown>): void {
    const peers = Array.isArray(body.peers)
      ? body.peers
          .map(identity)
          .filter((peer): peer is PeerIdentity => peer !== null)
      : [];
    const revision =
      typeof body.rosterRevision === "number"
        ? body.rosterRevision
        : rosterRevision;
    rosterRevision = revision;
    handlers?.onRoster({
      rosterRevision: revision,
      peers,
      ...(typeof body.expiresAt === "number"
        ? { grantExpiresAt: body.expiresAt }
        : {}),
      ...(typeof body.trafficStopMs === "number"
        ? { trafficStopMs: body.trafficStopMs }
        : {}),
    });
  }

  function publishSignals(body: Record<string, unknown>): void {
    const signals = Array.isArray(body.signals) ? body.signals : [];
    for (const raw of signals) {
      const envelope = record(raw);
      if (!envelope) continue;
      const from = identity(envelope);
      const type = signalType(envelope.type);
      if (!from || !type) continue;
      if (
        envelope.targetPersonUid !== self.personUid ||
        envelope.targetDeviceId !== self.deviceId
      ) {
        continue;
      }
      if (typeof envelope.payload !== "string") continue;
      let payload: unknown;
      try {
        payload = decodePayload(envelope.payload);
      } catch {
        handlers?.onError("INVALID_INPUT", "Undecodable signal payload.");
        continue;
      }
      const inbound: InboundSignal = {
        binding: {
          companyUid: String(envelope.companyUid),
          roomId: String(envelope.roomId),
          callId: String(envelope.callId),
          epoch: Number(envelope.epoch),
        },
        from,
        rosterRevision:
          typeof envelope.rosterRevision === "number"
            ? envelope.rosterRevision
            : -1,
        sequence:
          typeof envelope.sequence === "number" ? envelope.sequence : -1,
        type,
        payload: payload as SessionDescriptionLike | IceCandidateLike,
      };
      handlers?.onSignal(inbound);
    }
    const eventIds = Array.isArray(body.eventIds)
      ? body.eventIds.filter((id): id is string => typeof id === "string")
      : [];
    if (eventIds.length > 0) pendingAcks = [...pendingAcks, ...eventIds];
  }

  async function tick(): Promise<void> {
    if (!running) return;
    if (clock.now() >= nextRenewAt) {
      const renewed = await control("renew");
      if (renewed) {
        applyTiming(renewed);
        const renewedGrant = record(renewed.grant);
        if (renewedGrant && grant) {
          grant = {
            ...grant,
            grantId:
              typeof renewedGrant.grantId === "string"
                ? renewedGrant.grantId
                : grant.grantId,
            rosterRevision:
              typeof renewedGrant.rosterRevision === "number"
                ? renewedGrant.rosterRevision
                : grant.rosterRevision,
            expiresAt:
              typeof renewedGrant.expiresAt === "number"
                ? renewedGrant.expiresAt
                : grant.expiresAt,
          };
        }
      }
      if (!running) return;
    }

    const acks = pendingAcks;
    pendingAcks = [];
    const body = await control(
      "reconcile",
      acks.length > 0 ? { ackIds: acks } : {},
    );
    if (!running) return;
    if (!body) {
      // Reconcile failed: the acks are still outstanding, retry them next tick.
      pendingAcks = [...acks, ...pendingAcks];
      return;
    }
    if (typeof body.code === "string" && body.code !== "OK") {
      handlers?.onError(body.code, "Signaling queue is not usable.");
    }
    applyTiming(body);
    publishRoster(body);
    publishSignals(body);
  }

  function schedule(): void {
    if (!running) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = undefined;
      void tick()
        .catch((error: unknown) => {
          handlers?.onError(
            "SIGNALING_POLL_FAILED",
            error instanceof Error ? error.message : "Unknown error",
          );
        })
        .finally(() => {
          schedule();
        });
    }, currentPollMs);
  }

  return {
    async start(nextHandlers: SignalingHandlers, nextGrant: CallGrant) {
      if (running) return;
      handlers = nextHandlers;
      grant = { ...nextGrant };
      rosterRevision = nextGrant.rosterRevision;
      sequence = 0;
      pendingAcks = [];
      currentPollMs = pollMs;
      renewLeadMs = renewAfterDefault;
      leaseExpiresAt = nextGrant.expiresAt;
      nextRenewAt = nextGrant.expiresAt - renewLeadMs;
      running = true;
      // One immediate reconcile so the roster is known before the first poll.
      await tick();
      if (!running) return;
      schedule();
    },

    async send(outbound: OutboundSignal) {
      if (!running || !grant) return;
      sequence += 1;
      const envelope: Record<string, unknown> = {
        version: VERSION,
        kind: "signal",
        companyUid: binding.companyUid,
        roomId: binding.roomId,
        callId: binding.callId,
        epoch: binding.epoch,
        personUid: self.personUid,
        deviceId: self.deviceId,
        peerKey: self.peerKey,
        targetPersonUid: outbound.to.personUid,
        targetDeviceId: outbound.to.deviceId,
        grantId: grant.grantId,
        rosterRevision,
        sequence,
        type: outbound.type,
        payload: encodePayload(outbound.payload),
        sentAt: clock.now(),
      };
      const signature = await signer.sign(envelope);
      const result = await callsApi.sendSignal({
        signal: envelope as Json,
        signature,
      });
      if (!result.ok) handlers?.onError(refusalCode(result.code), refusal(result.message));
    },

    async stop() {
      running = false;
      if (pollTimer !== undefined) {
        timers.clearTimeout(pollTimer);
        pollTimer = undefined;
      }
      handlers = null;
      grant = null;
      pendingAcks = [];
      sequence = 0;
      nextRenewAt = Number.POSITIVE_INFINITY;
      leaseExpiresAt = null;
    },
  };
}
