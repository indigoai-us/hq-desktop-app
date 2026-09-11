/**
 * Call-window bootstrap (US-016).
 *
 * The lifetime of this window is owned by Rust (`commands/calls.rs`), so this
 * module never decides *whether* there is a call — it asks. On mount it drains
 * the pending target (cold open); if there is none it waits, bounded, for the
 * window-scoped `calls:target` event (warm open) and otherwise surfaces a clear
 * error state rather than idling forever. It then acknowledges the mount so the
 * host knows warm hand-off is live.
 *
 * Every dependency is injected, so the whole bootstrap — including the exact
 * invoke sequence — is testable with no webview, no WebRTC and no network.
 */

import {
  consentAckFields,
  createCallSession,
  createConsentGate,
  createContentDeliveryGate,
  createHqSignalingPort,
  type CallGrant,
  type CallSession,
  type CallSnapshot,
  type ConsentGate,
  type ConsentStatus,
  type ContentDeliveryGate,
  type IceServerLike,
  type MediaPort,
  type PeerConnectionConfig,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type TrackLike,
} from "@hq/meet-core";
import {
  CALLS_VERSION,
  createSyncPlatformAdapter,
  type IdentityApi,
} from "@hq/platform";

import {
  AUTH_SESSION_EVENT,
  createAccountBinding,
  parseAuthSessionEnvelope,
  resolveCallIdentity,
  type AccountBinding,
  type CallIdentityCode,
} from "./auth";
import {
  browserGetUserMedia,
  createMediaController,
  type GetUserMediaLike,
  type MediaController,
  type MediaControllerState,
  type MediaDeviceKind,
  type MediaPreferences,
  type PreferenceStorage,
} from "./permissions";
import {
  BUNDLED_EVIDENCE_MAX_AGE_MS,
  SERVICE_EVIDENCE,
} from "./service-evidence";
import { createDeviceSigner, type DeviceSigner } from "./signer";
import { isCallWindowTarget, type CallWindowTarget } from "./target";

export type CallInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export type CallListen = (
  event: string,
  handler: (event: { payload: unknown }) => void,
) => Promise<() => void>;

export type CallStatus =
  | "connecting"
  /** Paused on a recoverable identity refusal; a Retry is offered. */
  | "identity"
  | "waiting"
  | "joined"
  | "left"
  | "error";

export interface CallViewState {
  status: CallStatus;
  /** Content-free: a code, never SDP, candidates, keys or person content. */
  code: string | null;
  sessionId: string | null;
  peerCount: number;
  /** True when the current refusal can be retried in place. */
  recoverable: boolean;
  /** Per-device capture state, including denial + recovery guidance. */
  media: MediaControllerState;
  /** Remembered join intent. Never a reason to capture. */
  preferences: MediaPreferences;
  /** The consent-roster barrier, as the user sees it. */
  transcription: ConsentStatus;
  /** True when a consent acknowledgement could not be delivered. */
  consentUnavailable: boolean;
  /**
   * True once the canonical `prs_…` identity behind this window is proved.
   * The join controls are inert until it is: `connecting` is reached before
   * the identity gate answers, so status alone would enable the microphone
   * for a window that has not yet proved whose account it is.
   */
  identityResolved: boolean;
  /**
   * True while the host cannot refresh credentials. Nothing NEW is authorized
   * (join, grant, consent ack); established media runs to its grant's expiry.
   */
  authorityPaused: boolean;
}

export interface CallWindowDeps {
  invoke: CallInvoke;
  listen: CallListen;
  /** How long a cold mount waits for a warm `calls:target`. Default 5s. */
  targetWaitMs?: number;
  /** Injected in tests; production uses WebCrypto Ed25519. */
  createSigner?: () => Promise<DeviceSigner>;
  /** Injected in tests; production adapts a real `RTCPeerConnection`. */
  connections?: PeerConnectionFactory;
  /**
   * Identity source. Defaults to the Sync adapter's `IdentityApi`, which is
   * the ONLY canonical `prs_…` path on this host.
   */
  identity?: Pick<IdentityApi, "whoami">;
  /** Injected in tests; production is `navigator.mediaDevices.getUserMedia`. */
  getUserMedia?: GetUserMediaLike;
  /**
   * Where remembered join intent lives. Supplied by the entry (`main.ts`) —
   * this module never reaches for web storage itself, because the invariant
   * that the call target can only come from the native host is enforced by
   * this file containing no storage access at all.
   */
  storage?: PreferenceStorage | null;
  onState?: (state: CallViewState) => void;
  /** A remote track, with the key-free `personUid deviceId` peer label. */
  onTrack?: (track: TrackLike, peerId: string) => void;
  /**
   * Fired when content delivery closes for a peer (or the whole call). The
   * window drops that peer's media elements here; US-024+ transcript and file
   * delivery must consult `handle.content` and hang off this same event.
   */
  onContentClose?: (event: { peerId: string | null; reason: string }) => void;
}

export interface CallWindowHandle {
  readonly target: CallWindowTarget | null;
  readonly session: CallSession | null;
  /** Null until canonical identity resolved — there is no call before that. */
  readonly media: MediaController | null;
  readonly account: AccountBinding | null;
  readonly consent: ConsentGate | null;
  readonly content: ContentDeliveryGate;
  state(): CallViewState;
  /** Re-run the identity gate after a recoverable refusal. */
  retryIdentity(): Promise<void>;
  /** Explicit join controls. The only paths to `getUserMedia`. */
  setDevice(kind: MediaDeviceKind, on: boolean): Promise<void>;
  /** The explicit "Allow transcription" control. Off by default. */
  setTranscription(on: boolean): Promise<void>;
  /** Leave the call and release the registry entry. Idempotent. */
  leave(reason?: string): Promise<void>;
  /** Full teardown for app quit; acknowledges `calls_disposed`. */
  dispose(): Promise<void>;
  /** Stop listening. Called by the window's own teardown. */
  close(): Promise<void>;
}

/** Window-scoped event names. Never global broadcasts. */
export const CALL_TARGET_EVENT = "calls:target";
export const CALL_DISPOSE_EVENT = "calls:dispose";

const DEFAULT_TARGET_WAIT_MS = 5_000;

/**
 * Refusals a renewal can never fix. A traffic stop carrying one of these is
 * the end of the call, not a network hiccup, so its content close is
 * permanent. `GRANT_EXPIRED` is deliberately NOT here: `CallSession` records
 * it on every traffic stop, including the control-quiet one that a later
 * reconcile recovers from. Expiry is decided from `grantExpiresAt` instead.
 */
const UNRENEWABLE_CALL_CODES = new Set([
  "CALL_SEALED",
  "COMPANY_ACCESS_DENIED",
  "IDENTITY_MISMATCH",
  "STALE_EPOCH",
  "UNSUPPORTED_VERSION",
  "INVALID_SIGNATURE",
]);

/**
 * The view's starting state: connecting, nothing captured, transcription off.
 * Exported so the window's rune store and the tests share one shape.
 */
export function initialCallViewState(): CallViewState {
  return {
    status: "connecting",
    code: null,
    sessionId: null,
    peerCount: 0,
    recoverable: false,
    media: {
      microphone: { status: "idle", active: false, code: null, recovery: null },
      camera: { status: "idle", active: false, code: null, recovery: null },
    },
    preferences: { microphone: false, camera: false },
    transcription: "off",
    consentUnavailable: false,
    identityResolved: false,
    authorityPaused: false,
  };
}

/**
 * A real `RTCPeerConnection` narrowed to `PeerConnectionLike`. The engine only
 * uses the structural subset, so the adaptation is a cast at the boundary plus
 * the `ontrack` shape the engine expects.
 */
export function createBrowserConnections(): PeerConnectionFactory {
  return {
    create(config: PeerConnectionConfig): PeerConnectionLike {
      const pc = new RTCPeerConnection({
        iceServers: (config.iceServers ?? []) as RTCIceServer[],
      });
      return pc as unknown as PeerConnectionLike;
    },
  };
}

/**
 * This story attaches NO local capture: joining with camera and microphone is
 * US-017's explicit join control. The port exists so the session has one, and
 * `ownsTracks` is true so anything US-017 hands it is stopped on leave/dispose.
 */
export function createNoCaptureMediaPort(
  tracks: () => TrackLike[] = () => [],
  iceServers: () => IceServerLike[] = () => [],
): MediaPort {
  return {
    localTracks: () => tracks(),
    ownsTracks: true,
    iceServers: () => iceServers(),
  };
}

/**
 * Drain the pending target, or wait (bounded) for the warm one.
 *
 * Exactly one target reaches the window: the pending slot is drained once by
 * Rust, and the event listener is torn down as soon as a target arrives.
 */
export async function resolveCallTarget(
  deps: Pick<CallWindowDeps, "invoke" | "listen" | "targetWaitMs">,
): Promise<CallWindowTarget | null> {
  const pending = await deps.invoke("calls_take_pending_target");
  if (isCallWindowTarget(pending)) return pending;

  const warm = await waitForWarmTarget(deps);
  if (warm) return warm;

  // The arm-then-emit race: Rust arms the pending slot and only then emits, so
  // a target armed after our first drain but whose emit we missed (window
  // mid-reload, listener registered a tick late) is still sitting in the slot.
  // Drain once more before giving up — the slot yields at most one target, so
  // this can never double-deliver.
  const late = await deps.invoke("calls_take_pending_target").catch(() => null);
  return isCallWindowTarget(late) ? late : null;
}

/** Bounded wait for the window-scoped warm target. Null on timeout. */
function waitForWarmTarget(
  deps: Pick<CallWindowDeps, "listen" | "targetWaitMs">,
): Promise<CallWindowTarget | null> {
  const waitMs = deps.targetWaitMs ?? DEFAULT_TARGET_WAIT_MS;
  return new Promise<CallWindowTarget | null>((resolve) => {
    let settled = false;
    let unlisten: (() => void) | null = null;
    const timer = setTimeout(() => finish(null), waitMs);

    function finish(target: CallWindowTarget | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unlisten?.();
      resolve(target);
    }

    void deps
      .listen(CALL_TARGET_EVENT, (event) => {
        if (isCallWindowTarget(event.payload)) finish(event.payload);
      })
      .then((off) => {
        if (settled) off();
        else unlisten = off;
      })
      .catch(() => finish(null));
  });
}

/** The backend's admit answer, reduced to what the session and port need. */
export interface CallAdmission {
  grant: CallGrant;
  renewAfterMs?: number;
  controlPollMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/**
 * Read a signaling `admit` response into a `CallGrant`.
 *
 * The role comes from the BACKEND, not from the opener: this window is a
 * participant unless the service says it hosts the room. A response without a
 * usable grantId/expiresAt is not a weaker admission, it is none at all.
 */
export function admissionFromControl(value: unknown): CallAdmission | null {
  const body = record(value);
  const grant = record(body?.grant);
  const grantId = grant && typeof grant.grantId === "string" ? grant.grantId : "";
  const expiresAt = grant ? positive(grant.expiresAt) : undefined;
  if (!grantId || expiresAt === undefined) return null;
  const role =
    grant?.role === "host" || grant?.role === "cohost"
      ? grant.role
      : "participant";
  const trafficStopMs = positive(body?.trafficStopMs);
  const renewAfterMs = positive(body?.renewAfterMs);
  const controlPollMs = positive(body?.controlPollMs);
  return {
    grant: {
      grantId,
      role,
      rosterRevision:
        typeof grant?.rosterRevision === "number" ? grant.rosterRevision : 0,
      expiresAt,
      ...(trafficStopMs === undefined ? {} : { trafficStopMs }),
    },
    ...(renewAfterMs === undefined ? {} : { renewAfterMs }),
    ...(controlPollMs === undefined ? {} : { controlPollMs }),
  };
}

/**
 * Build the signed `admit` envelope this window admits itself with.
 *
 * `publicKey` is mandatory for admit: the backend records it as the admission
 * proof and derives every later envelope's verifier from it. The knock ids ride
 * along only when the target carried an accepted knock — the backend refuses a
 * half pair, and a private room without one is refused outright.
 */
export function admitEnvelope(
  target: CallWindowTarget,
  signer: DeviceSigner,
  requestId: string,
  sentAt: number,
): Record<string, unknown> {
  return {
    version: CALLS_VERSION,
    kind: "control",
    companyUid: target.companyUid,
    roomId: target.roomId,
    callId: target.callId,
    epoch: target.epoch,
    operation: "admit",
    personUid: target.self.personUid,
    deviceId: target.self.deviceId,
    peerKey: signer.peerKey,
    publicKey: signer.publicKey,
    requestId,
    sentAt,
    ...(target.knock
      ? { knockId: target.knock.knockId, capabilityId: target.knock.capabilityId }
      : {}),
  };
}

/** The placeholder durable record US-024+ fills in with real transcript work. */
export function pendingCompletionState(
  target: CallWindowTarget,
): Record<string, unknown> {
  return {
    version: 1,
    sessionId: target.sessionId,
    binding: {
      companyUid: target.companyUid,
      roomId: target.roomId,
      callId: target.callId,
      epoch: target.epoch,
    },
    pendingCompletion: null,
  };
}

/**
 * Mount the call window: resolve the target, acknowledge readiness, preflight
 * the adapter, resolve and BIND the account, then build the session and join.
 *
 * The ordering is the security property. Identity resolves before any signer
 * is minted and before any grant is used; the account binding is armed before
 * the identity request goes out, so a switch that happens mid-request is seen
 * when the answer lands rather than after the join.
 */
export async function startCallWindow(
  deps: CallWindowDeps,
): Promise<CallWindowHandle> {
  const listeners: Array<() => void> = [];

  /**
   * The content gate is re-creatable on purpose.
   *
   * `ContentDeliveryGate` is a one-way latch by design — a peer closed on an
   * authoritative event is never re-admitted, because a rejoin is a new device
   * key. That is right for removal and for a dead grant, and wrong for the
   * control-quiet traffic stop, which is a *recoverable* condition: control
   * went silent, the session dropped its transports, and a later reconcile
   * rebuilds them. Blanking the window permanently there would leave a call
   * that is demonstrably alive showing nothing forever. So a recoverable stop
   * closes the current gate (renderers drop their elements synchronously, as
   * they must) and recovery installs a FRESH gate rather than re-opening the
   * latched one.
   */
  let content = wireContentGate(createContentDeliveryGate());
  function wireContentGate(gate: ContentDeliveryGate): ContentDeliveryGate {
    if (deps.onContentClose) {
      gate.onClose((event) =>
        deps.onContentClose?.({ peerId: event.peerId, reason: event.reason }),
      );
    }
    return gate;
  }
  /** True while content is closed by a condition a later snapshot can undo. */
  let contentPaused = false;
  /** True once content is closed for good: no snapshot may re-open it. */
  let contentTerminated = false;

  let state: CallViewState = initialCallViewState();
  const publish = (next: Partial<CallViewState>): void => {
    state = { ...state, ...next };
    deps.onState?.(state);
  };
  publish({});

  const target = await resolveCallTarget(deps);
  if (!target) {
    publish({ status: "error", code: "NO_CALL_TARGET" });
    return inertHandle(null, () => state, listeners, content);
  }
  publish({ sessionId: target.sessionId });

  // Acknowledge the mount BEFORE any slow work: from here the host may warm
  // hand-off instead of re-arming a pending target.
  await deps.invoke("calls_window_ready", { sessionId: target.sessionId });

  const adapter = createSyncPlatformAdapter({
    invoke: (command, args) => deps.invoke(command, args) as Promise<never>,
    // Production never uses window.fetch — the bearer stays in Rust.
    fetch: (() => {
      throw new Error("the call window must not fetch directly");
    }) as unknown as typeof fetch,
  });

  // Service evidence is a property of THIS BUILD, not of the opener: the
  // bundled US-011 receipt is used identically here and in the main window.
  // The bundled receipt ages with the BUILD, not with this session, so it
  // carries its own explicit lifetime rather than the per-session default.
  // Still fail-closed: past the bound this refuses with EVIDENCE_STALE.
  const preflight = await adapter.calls.preflight(SERVICE_EVIDENCE, {
    maxAgeMs: BUNDLED_EVIDENCE_MAX_AGE_MS,
  });
  if (!preflight.ok) {
    publish({ status: "error", code: preflight.code });
    await releaseOnly(deps, target, "preflight-failed");
    return inertHandle(target, () => state, listeners, content);
  }

  // ------------------------------------------------------------------
  // Account binding
  // ------------------------------------------------------------------

  // The generation this window binds to. Read from the host rather than
  // assumed: an unreadable envelope binds generation 0, which every real
  // `auth:session-changed` (generation >= 1) then invalidates.
  const session0 = parseAuthSessionEnvelope(
    await deps.invoke("get_auth_session").catch(() => null),
  );
  const account = createAccountBinding({
    generation: session0?.generation ?? 0,
    accountId: session0?.accountId ?? null,
    personUid: target.self.personUid,
    // The window's OWN company. It subscribes to nothing company-scoped, so
    // navigating the main window elsewhere cannot re-attribute this call.
    companyUid: target.companyUid,
  });
  const generation = account.generation;

  // The controller is created before the identity gate so the view has a
  // stable shape, but it can only capture from an explicit control, and the
  // join controls stay disabled until identity resolves.
  const mediaController = createMediaController({
    getUserMedia: deps.getUserMedia ?? browserGetUserMedia(),
    storage: deps.storage ?? null,
    onChange: (next) => publish({ media: next }),
  });
  publish({
    media: mediaController.state(),
    preferences: mediaController.preferences(),
  });

  const consent = createConsentGate({
    clock: { now: () => Date.now() },
    selfPersonUid: target.self.personUid,
  });
  listeners.push(
    consent.subscribe((snapshot) =>
      publish({
        transcription: snapshot.status,
        consentUnavailable: snapshot.acknowledgementUnavailable,
      }),
    ),
  );

  let session: CallSession | null = null;
  let finished = false;
  let joining = false;
  /** Peers admitted by the last authoritative snapshot, for removal diffing. */
  let currentPeers: string[] = [];
  /**
   * The device signer, hoisted out of `join` so the consent path can reach it.
   * A consent acknowledgement is a signed `consentControl` envelope by its own
   * bearer — the backend derives the actor from the signature, so an unsigned
   * body is not a weaker acknowledgement, it is not an acknowledgement at all.
   */
  let deviceSigner: DeviceSigner | null = null;
  /**
   * The grant the envelopes are filed under; renewals move it. Empty until the
   * window has admitted itself — there is no opener-supplied grant any more.
   */
  let currentGrantId = "";
  /** Monotonic requestId suffix for this window's own control envelopes. */
  let controlRequests = 0;
  /** In-flight guard + last-sent generation, so one epoch gets ONE ack. */
  let ackInFlight = false;
  let lastAck: string | null = null;
  /** Last `selfNotAdmitted` count seen, so a new one is an edge not a level. */
  let selfNotAdmittedSeen = 0;

  // Arm the account listener BEFORE the first identity request so a switch
  // during that request is already known when the answer lands.
  listeners.push(
    await deps.listen(AUTH_SESSION_EVENT, (event) => {
      const envelope = parseAuthSessionEnvelope(event.payload);
      if (envelope) account.accept(envelope);
    }),
  );
  account.onInvalidate(() => {
    void invalidate();
  });
  listeners.push(
    account.onAuthorityChange((paused) => publish({ authorityPaused: paused })),
  );

  /**
   * The account changed. Everything the old account had goes away NOW, in an
   * order that never leaves capture running: tracks first, then the session,
   * then the registry entry.
   */
  async function invalidate(): Promise<void> {
    if (finished) return;
    finished = true;
    mediaController.stopAll("account-changed");
    consent.setEnabled(false);
    content.closeAll("account-changed");
    publish({
      status: "error",
      code: "ACCOUNT_CHANGED",
      recoverable: false,
      peerCount: 0,
    });
    try {
      await session?.dispose();
    } catch {
      // A failed dispose must not stop the release: the entry has to clear.
    }
    session = null;
    await deps
      .invoke("calls_release", {
        sessionId: target!.sessionId,
        reason: "account-changed",
      })
      .catch(() => {});
  }

  async function persistPending(): Promise<void> {
    try {
      await deps.invoke("calls_persist_pending", {
        sessionId: target!.sessionId,
        state: pendingCompletionState(target!),
      });
    } catch {
      // Durable-work persistence is best effort; it must never block a leave
      // (and therefore never keep the camera on).
    }
  }

  async function leave(reason = "user-left"): Promise<void> {
    if (finished) return;
    finished = true;
    await persistPending();
    mediaController.stopAll(reason);
    content.closeAll("left");
    try {
      await session?.leave();
    } finally {
      publish({ status: "left", peerCount: 0 });
      try {
        await deps.invoke("calls_release", {
          sessionId: target!.sessionId,
          reason,
        });
      } catch {
        // The window is going away regardless.
      }
    }
  }

  async function dispose(): Promise<void> {
    if (!finished) {
      finished = true;
      await persistPending();
    }
    mediaController.stopAll("dispose");
    content.closeAll("left");
    try {
      await session?.dispose();
    } finally {
      publish({ status: "left", peerCount: 0 });
      try {
        await deps.invoke("calls_disposed", { sessionId: target!.sessionId });
      } catch {
        // Quit continues with or without the ack.
      }
    }
  }

  listeners.push(
    await deps.listen(CALL_DISPOSE_EVENT, () => {
      void dispose();
    }),
  );

  /**
   * Build the session and join — only ever reached with a resolved canonical
   * identity and a current generation.
   */
  async function join(): Promise<void> {
    if (joining || finished || session) return;
    joining = true;
    try {
      if (account.authorityPaused) return;
      let signer: DeviceSigner;
      try {
        signer = await (deps.createSigner ?? createDeviceSigner)();
      } catch {
        publish({ status: "error", code: "DEVICE_KEY_UNAVAILABLE" });
        await releaseOnly(deps, target!, "device-key-unavailable");
        return;
      }
      // A key minted for an account that is already gone must never be used.
      if (!account.isCurrent(generation)) return;
      deviceSigner = signer;

      const binding = {
        companyUid: target!.companyUid,
        roomId: target!.roomId,
        callId: target!.callId,
        epoch: target!.epoch,
      };
      const self = {
        personUid: target!.self.personUid,
        deviceId: target!.self.deviceId,
        peerKey: signer.peerKey,
      };
      const clock = { now: () => Date.now() };

      // ---- admit ourselves -------------------------------------------------
      // The opener cannot mint a grant for a key it does not have. This window
      // signs its OWN admit with the key it just minted, so the grant the
      // backend issues is bound to the peer key every later envelope carries.
      controlRequests += 1;
      const envelope = admitEnvelope(
        target!,
        signer,
        `admit-${clock.now().toString(36)}-${controlRequests}`,
        clock.now(),
      );
      const signature = await signer.sign(envelope);
      const admitResult = await adapter.calls.signalingControl("admit", {
        ...envelope,
        signature,
      } as never);
      // The admit answer is worthless if the account moved while it was in the
      // air — the same rule the join below applies to its own result.
      if (!account.isCurrent(generation)) return;
      if (!admitResult.ok) {
        publish({
          status: "error",
          code: admitResult.code ?? "ADMIT_REFUSED",
          recoverable: false,
        });
        await releaseOnly(deps, target!, "admit-refused");
        return;
      }
      const admission = admissionFromControl(admitResult.value);
      if (!admission) {
        publish({ status: "error", code: "ADMIT_REFUSED", recoverable: false });
        await releaseOnly(deps, target!, "admit-refused");
        return;
      }
      currentGrantId = admission.grant.grantId;
      const timers = {
        setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
        clearTimeout: (handle: unknown) => clearTimeout(handle as never),
      };

      const live = createCallSession({
        binding,
        self,
        sessionId: target!.sessionId,
        ports: {
          signaling: createHqSignalingPort(adapter.calls, signer, {
            binding,
            self,
            clock,
            timers,
            ...(admission.controlPollMs === undefined
              ? {}
              : { defaultPollMs: admission.controlPollMs }),
            ...(admission.renewAfterMs === undefined
              ? {}
              : { defaultRenewAfterMs: admission.renewAfterMs }),
          }),
          // Capture is the controller's, and only ever from a join control.
          media: createNoCaptureMediaPort(() => mediaController.tracks()),
          connections: deps.connections ?? createBrowserConnections(),
          clock,
          timers,
        },
      });
      session = live;

      listeners.push(
        live.on("state", ({ snapshot }: { snapshot: CallSnapshot }) =>
          onSnapshot(snapshot),
        ),
        live.on("error", ({ code }: { code: string }) => {
          publish({ status: "error", code, recoverable: false });
        }),
      );
      if (deps.onTrack) {
        listeners.push(
          live.on("track", ({ peer, track }) => {
            const peerId = `${peer.personUid} ${peer.deviceId}`;
            // Content from a peer whose delivery already closed is dropped
            // here rather than rendered and torn down a frame later.
            if (!content.allows(peerId)) return;
            deps.onTrack?.(track, peerId);
          }),
        );
      }

      try {
        await live.join(admission.grant);
      } catch {
        publish({ status: "error", code: "JOIN_FAILED", recoverable: false });
        return;
      }
      // The grant landed. If the account changed while it was in the air, it
      // is worthless: discard it rather than letting the old session capture.
      if (!account.isCurrent(generation)) {
        await invalidate();
      }
    } finally {
      joining = false;
    }
  }

  /**
   * Fold one authoritative snapshot into the view, the content gate and the
   * consent-roster barrier. This is the single place a membership change is
   * acted on, so media/data close and the transcription barrier move together.
   */
  function onSnapshot(snapshot: CallSnapshot): void {
    if (snapshot.grantId) currentGrantId = snapshot.grantId;

    // ---- our OWN admission ------------------------------------------------
    // The roster is authoritative about us too. If it no longer lists this
    // device, our admission was revoked (or expired): we hold no right to
    // deliver or capture anything, and the session has already dropped every
    // transport. Close call-wide and stop local capture — a revoked
    // participant whose camera stayed on is the whole failure this gate exists
    // to prevent.
    const notAdmitted = snapshot.diagnostics.selfNotAdmitted ?? 0;
    const selfId = `${snapshot.self.personUid} ${snapshot.self.deviceId}`;
    const rosterKnowsSelf =
      snapshot.rosterRevision < 1 ||
      snapshot.admitted.some(
        (entry) => `${entry.personUid} ${entry.deviceId}` === selfId,
      );
    if (notAdmitted > selfNotAdmittedSeen || !rosterKnowsSelf) {
      selfNotAdmittedSeen = notAdmitted;
      if (!contentTerminated) {
        contentTerminated = true;
        contentPaused = false;
        content.closeAll("not-admitted");
      }
      mediaController.stopAll("not-admitted");
      currentPeers = [];
      consent.setEnabled(false);
      publish({
        status: "error",
        code: "ADMISSION_REVOKED",
        recoverable: false,
        peerCount: 0,
      });
      return;
    }

    // ---- recovery ---------------------------------------------------------
    // Control is talking again and membership has been rebuilt: install a
    // fresh gate so the recovered peers render. `contentTerminated` is never
    // undone — an expired grant and a revoked admission stay closed.
    if (
      contentPaused &&
      !contentTerminated &&
      !snapshot.trafficStopped &&
      snapshot.peers.length > 0
    ) {
      contentPaused = false;
      currentPeers = [];
      content = wireContentGate(createContentDeliveryGate());
    }

    const peerIds = snapshot.peers.map((peer) => peer.peerId);
    const present = new Set(peerIds);
    // Peer removal is authoritative: close the departed peer's delivery now.
    for (const peerId of currentPeers) {
      if (!present.has(peerId)) content.closePeer(peerId, "peer-removed");
    }
    currentPeers = peerIds;
    content.admit(peerIds);

    // ---- traffic stop -----------------------------------------------------
    if (snapshot.trafficStopped && content.open()) {
      // Two very different conditions arrive as one flag. An expired or
      // terminally refused grant cannot be renewed, so its close is permanent.
      // A control-quiet stop is the watchdog firing while the grant is still
      // valid — recoverable, and a later reconcile brings the call back.
      const expired =
        snapshot.grantExpiresAt !== null &&
        snapshot.grantExpiresAt <= Date.now();
      const terminal = snapshot.errors.some((error) =>
        UNRENEWABLE_CALL_CODES.has(error.code),
      );
      content.closeAll("traffic-stopped");
      if (expired || terminal) contentTerminated = true;
      else contentPaused = true;
    }

    // The consent barrier follows the ADMITTED roster, not the transports we
    // happen to hold: a participant who is admitted but not yet connected is
    // still someone whose audio must not be recognized without their consent.
    const admittedPersons =
      snapshot.admitted.length > 0
        ? [...new Set(snapshot.admitted.map((entry) => entry.personUid))]
        : [
            snapshot.self.personUid,
            ...snapshot.peers.map((peer) => peer.personUid),
          ];
    consent.observeRoster({
      rosterRevision: snapshot.rosterRevision,
      participants: admittedPersons,
    });

    publish({
      status:
        snapshot.phase === "joined"
          ? "joined"
          : snapshot.phase === "disposed" || snapshot.phase === "idle"
            ? "left"
            : state.status === "error"
              ? "error"
              : "connecting",
      peerCount: snapshot.peers.length,
    });
    // A newly admitted participant needs a fresh acknowledgement before
    // transcription can resume; pausing already happened in `observeRoster`.
    //
    // Snapshots arrive on every reconcile, so this condition holds for as long
    // as we are waiting on somebody ELSE to acknowledge — which would post an
    // ack per poll. One acknowledgement per (epoch, roster) generation is all
    // the backend can use; the rest is write amplification against a
    // rate-limited control plane. The memo is set before the send, so a second
    // snapshot arriving mid-flight finds it already claimed.
    if (consent.snapshot().enabled && !consent.recognitionAllowed()) {
      const barrier = consent.snapshot();
      const memo = `${consent.nextConsentEpoch()}:${barrier.rosterRevision}`;
      if (!ackInFlight && lastAck !== memo) {
        ackInFlight = true;
        lastAck = memo;
        void sendConsentAck(true).finally(() => {
          ackInFlight = false;
        });
      }
    }
  }

  /**
   * Send this actor's own SIGNED consent acknowledgement (or withdrawal).
   *
   * `CompletionConsentService` derives the acknowledging person from the
   * envelope's signature over a live admission — not from any field in the
   * body. So the envelope has to be the full backend `consentInput` shape,
   * signed with the same device key `createHqSignalingPort` signs control
   * envelopes with; a body without `personUid`/`deviceId`/`peerKey`/`grantId`/
   * `sentAt`/`signature` is refused, and one that a *different* key signed
   * would be an acknowledgement on someone else's behalf.
   */
  async function sendConsentAck(acknowledged: boolean): Promise<void> {
    if (finished || !account.isCurrent(generation)) return;
    if (account.authorityPaused) {
      // No new authority while the host cannot prove the account: an
      // acknowledgement is exactly that.
      consent.noteAcknowledgementUnavailable();
      return;
    }
    const signer = deviceSigner;
    if (!signer) {
      // No device key means no way to speak for this actor at all.
      consent.noteAcknowledgementUnavailable();
      return;
    }
    const fields = consentAckFields(
      consent,
      acknowledged,
      // Explicit: this window runs no processor of its own (US-024+), so it
      // files against whichever processor the open proof was formed for.
      consent.snapshot().processorId,
    );
    if (fields.rosterRevision < 1 || fields.consentEpoch < 1) {
      // No roster yet: there is nothing to consent over, and the backend
      // refuses revision 0. Stay paused and visible.
      consent.noteAcknowledgementUnavailable();
      return;
    }
    const envelope: Record<string, unknown> = {
      version: CALLS_VERSION,
      kind: "consentControl",
      companyUid: target!.companyUid,
      roomId: target!.roomId,
      callId: target!.callId,
      epoch: target!.epoch,
      personUid: target!.self.personUid,
      deviceId: target!.self.deviceId,
      peerKey: signer.peerKey,
      grantId: currentGrantId,
      sentAt: Date.now(),
      consentEpoch: fields.consentEpoch,
      rosterRevision: fields.rosterRevision,
      processorId: fields.processorId,
      acknowledged: fields.acknowledged,
    };
    let signature: string;
    try {
      signature = await signer.sign(envelope);
    } catch {
      consent.noteAcknowledgementUnavailable();
      return;
    }
    if (finished || !account.isCurrent(generation)) return;
    const result = await adapter.calls
      .completionConsent({ ...envelope, signature })
      .catch(() => ({ ok: false as const }));
    if (!account.isCurrent(generation)) return;
    if (!result.ok) {
      // An unavailable acknowledgement leaves transcription visibly paused —
      // never optimistically ready.
      consent.noteAcknowledgementUnavailable();
      return;
    }
    const proof = (result as { value?: unknown }).value;
    if (proof && typeof proof === "object") {
      const candidate = proof as Record<string, unknown>;
      if (
        typeof candidate.consentEpoch === "number" &&
        typeof candidate.rosterRevision === "number" &&
        Array.isArray(candidate.participants) &&
        Array.isArray(candidate.acknowledged)
      ) {
        consent.applyProof({
          revision: typeof candidate.revision === "number" ? candidate.revision : 1,
          consentEpoch: candidate.consentEpoch,
          rosterRevision: candidate.rosterRevision,
          processorId:
            typeof candidate.processorId === "string"
              ? candidate.processorId
              : null,
          participants: (candidate.participants as unknown[]).map((entry) =>
            typeof entry === "string"
              ? entry
              : String((entry as { personUid?: unknown })?.personUid ?? ""),
          ),
          acknowledged: (candidate.acknowledged as unknown[]).map(String),
          readyAt:
            typeof candidate.readyAt === "number" ? candidate.readyAt : null,
          pausedAt:
            typeof candidate.pausedAt === "number" ? candidate.pausedAt : null,
        });
      }
    }
  }

  /** The identity gate. Runs before the signer, and again on every Retry. */
  async function gateIdentity(): Promise<boolean> {
    if (finished) return false;
    const resolved = await resolveCallIdentity({
      identity: deps.identity ?? adapter.identity,
      expected: {
        personUid: target!.self.personUid,
        companyUid: target!.companyUid,
      },
      generation,
      binding: account,
    });
    if (resolved.ok) {
      publish({ identityResolved: true });
      return true;
    }
    publish({ identityResolved: false });
    const code: CallIdentityCode = resolved.code;
    publish({
      status: resolved.recoverable ? "identity" : "error",
      code,
      recoverable: resolved.recoverable,
    });
    if (!resolved.recoverable) {
      // Not our call to hold: release the registry entry so a correct open
      // is not refused with CALL_ACTIVE.
      mediaController.stopAll(code);
      content.closeAll("account-changed");
      finished = true;
      await releaseOnly(deps, target!, code.toLowerCase());
    }
    return false;
  }

  const handle: CallWindowHandle = {
    target,
    get session(): CallSession | null {
      return session;
    },
    media: mediaController,
    account,
    consent,
    // A getter: a recoverable traffic stop installs a fresh gate, and every
    // holder must see the live one rather than the closed one it started with.
    get content(): ContentDeliveryGate {
      return content;
    },
    state: () => state,

    async retryIdentity(): Promise<void> {
      if (finished || session) return;
      publish({ status: "connecting", code: null, recoverable: false });
      if (await gateIdentity()) await join();
    },

    async setDevice(kind: MediaDeviceKind, on: boolean): Promise<void> {
      if (finished) return;
      if (!on) {
        if (kind === "microphone") mediaController.disableMicrophone();
        else mediaController.disableCamera();
      } else {
        await (kind === "microphone"
          ? mediaController.enableMicrophone()
          : mediaController.enableCamera());
      }
      publish({ preferences: mediaController.preferences() });
      // Republish without a rejoin: the port reads the controller's tracks.
      session?.refreshLocalTracks();
    },

    async setTranscription(on: boolean): Promise<void> {
      if (finished) return;
      consent.setEnabled(on);
      if (!on) {
        // Withdrawal applies the same barrier, locally first.
        consent.withdraw();
      }
      await sendConsentAck(on);
    },

    leave,
    dispose,
    close: async () => {
      for (const off of listeners.splice(0)) off();
    },
  };

  if (await gateIdentity()) await join();
  return handle;
}

/** How long a close waits for an in-flight bootstrap to hand back a handle. */
export const CLOSE_BOOTSTRAP_WAIT_MS = 1_000;

export interface CloseRequestedDeps {
  /** The live handle, or null while `startCallWindow` is still in flight. */
  handle: () => CallWindowHandle | null;
  /** The in-flight bootstrap. Awaited (bounded) when there is no handle yet. */
  started: Promise<CallWindowHandle>;
  /** The session id, known as soon as the target resolved. */
  sessionId: () => string | null;
  invoke: CallInvoke;
  /** Stop the close so teardown can finish first. */
  preventDefault: () => void;
  destroy: () => Promise<void>;
  waitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Close the call window WITHOUT ever leaking a live call.
 *
 * The dangerous case is closing *before* the bootstrap resolved: there is no
 * handle to leave with, but Rust may already hold an armed registry entry, and
 * returning early there would close the window and leave the registry hot —
 * every later open refused with `CALL_ACTIVE`. So the close is always
 * prevented, the in-flight bootstrap is given a bounded chance to land, the
 * handle (if one arrived) leaves the call, any known session is released, and
 * only then does the window actually go away.
 */
export async function handleCloseRequested(
  deps: CloseRequestedDeps,
): Promise<void> {
  deps.preventDefault();

  if (!deps.handle()) {
    const waitMs = deps.waitMs ?? CLOSE_BOOTSTRAP_WAIT_MS;
    const setTimer =
      deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const clearTimer =
      deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
    let timer: unknown;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimer(() => resolve(null), waitMs);
    });
    try {
      await Promise.race([deps.started.catch(() => null), timeout]);
    } finally {
      clearTimer(timer);
    }
  }

  const handle = deps.handle();
  try {
    await handle?.leave("window-close");
  } catch {
    // The window is going away regardless; a failed leave must never wedge it.
  }

  // Belt and braces: if the bootstrap never landed, `leave` never ran, so the
  // registry entry Rust armed for this session is still there. Release it by id
  // — `calls_release` is idempotent, so doing it after a successful leave is
  // harmless too.
  const sessionId = deps.sessionId();
  if (!handle && sessionId) {
    await deps
      .invoke("calls_release", {
        sessionId,
        reason: "window-close-before-ready",
      })
      .catch(() => {});
  }

  try {
    await handle?.close();
  } catch {
    // Same: listener teardown must not block the destroy.
  }
  await deps.destroy();
}

async function releaseOnly(
  deps: CallWindowDeps,
  target: CallWindowTarget,
  reason: string,
): Promise<void> {
  try {
    await deps.invoke("calls_release", { sessionId: target.sessionId, reason });
  } catch {
    // Nothing to do: the window will close and Rust drops the entry on quit.
  }
}

/**
 * A handle for a window that never got a live call: no target, a failed
 * preflight. Every control is a no-op, but the content gate is real and
 * already closed, so nothing downstream can deliver against it.
 */
function inertHandle(
  target: CallWindowTarget | null,
  state: () => CallViewState,
  listeners: Array<() => void>,
  content: ContentDeliveryGate,
): CallWindowHandle {
  content.closeAll("left");
  return {
    target,
    session: null,
    media: null,
    account: null,
    consent: null,
    content,
    state,
    retryIdentity: async () => {},
    setDevice: async () => {},
    setTranscription: async () => {},
    leave: async () => {},
    dispose: async () => {},
    close: async () => {
      for (const off of listeners.splice(0)) off();
    },
  };
}
