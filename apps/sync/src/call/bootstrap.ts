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
  createCallSession,
  createHqSignalingPort,
  type CallGrant,
  type CallSession,
  type CallSnapshot,
  type IceServerLike,
  type MediaPort,
  type PeerConnectionConfig,
  type PeerConnectionFactory,
  type PeerConnectionLike,
  type TrackLike,
} from "@hq/meet-core";
import { createSyncPlatformAdapter } from "@hq/platform";

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
  onState?: (state: CallViewState) => void;
  onTrack?: (track: TrackLike) => void;
}

export interface CallWindowHandle {
  readonly target: CallWindowTarget | null;
  readonly session: CallSession | null;
  state(): CallViewState;
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

function grantOf(target: CallWindowTarget): CallGrant {
  return {
    grantId: target.grant.grantId,
    // Phase 1 hands every joiner the participant role; host/cohost promotion
    // arrives with the roster from reconcile, not from the opener.
    role: "participant",
    rosterRevision: 0,
    expiresAt: target.grant.expiresAt,
    ...(target.grant.trafficStopMs === undefined
      ? {}
      : { trafficStopMs: target.grant.trafficStopMs }),
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
 * the adapter, build the meet-core session and join.
 */
export async function startCallWindow(
  deps: CallWindowDeps,
): Promise<CallWindowHandle> {
  const listeners: Array<() => void> = [];
  let state: CallViewState = {
    status: "connecting",
    code: null,
    sessionId: null,
    peerCount: 0,
  };
  const publish = (next: Partial<CallViewState>): void => {
    state = { ...state, ...next };
    deps.onState?.(state);
  };
  publish({});

  const target = await resolveCallTarget(deps);
  if (!target) {
    publish({ status: "error", code: "NO_CALL_TARGET" });
    return {
      target: null,
      session: null,
      state: () => state,
      leave: async () => {},
      dispose: async () => {},
      close: async () => {
        for (const off of listeners.splice(0)) off();
      },
    };
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

  const preflight = await adapter.calls.preflight(target.evidence);
  if (!preflight.ok) {
    publish({ status: "error", code: preflight.code });
    await releaseOnly(deps, target, "preflight-failed");
    return staticHandle(target, () => state, listeners, deps);
  }

  let signer: DeviceSigner;
  try {
    signer = await (deps.createSigner ?? createDeviceSigner)();
  } catch {
    publish({ status: "error", code: "DEVICE_KEY_UNAVAILABLE" });
    await releaseOnly(deps, target, "device-key-unavailable");
    return staticHandle(target, () => state, listeners, deps);
  }

  const binding = {
    companyUid: target.companyUid,
    roomId: target.roomId,
    callId: target.callId,
    epoch: target.epoch,
  };
  const self = {
    personUid: target.self.personUid,
    deviceId: target.self.deviceId,
    peerKey: signer.peerKey,
  };
  const clock = { now: () => Date.now() };
  const timers = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as never),
  };

  const session = createCallSession({
    binding,
    self,
    sessionId: target.sessionId,
    ports: {
      signaling: createHqSignalingPort(adapter.calls, signer, {
        binding,
        self,
        clock,
        timers,
        ...(target.grant.controlPollMs === undefined
          ? {}
          : { defaultPollMs: target.grant.controlPollMs }),
        ...(target.grant.renewAfterMs === undefined
          ? {}
          : { defaultRenewAfterMs: target.grant.renewAfterMs }),
      }),
      media: createNoCaptureMediaPort(),
      connections: deps.connections ?? createBrowserConnections(),
      clock,
      timers,
    },
  });

  listeners.push(
    session.on("state", ({ snapshot }: { snapshot: CallSnapshot }) => {
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
    }),
    session.on("error", ({ code }: { code: string }) => {
      publish({ status: "error", code });
    }),
  );
  if (deps.onTrack) {
    listeners.push(
      session.on("track", ({ track }: { track: TrackLike }) =>
        deps.onTrack?.(track),
      ),
    );
  }

  let finished = false;

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
    try {
      await session.leave();
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
    try {
      await session.dispose();
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
    ...(await Promise.all([
      deps.listen(CALL_DISPOSE_EVENT, () => {
        void dispose();
      }),
    ])),
  );

  try {
    await session.join(grantOf(target));
  } catch {
    publish({ status: "error", code: "JOIN_FAILED" });
  }

  return {
    target,
    session,
    state: () => state,
    leave,
    dispose,
    close: async () => {
      for (const off of listeners.splice(0)) off();
    },
  };
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

function staticHandle(
  target: CallWindowTarget,
  state: () => CallViewState,
  listeners: Array<() => void>,
  _deps: CallWindowDeps,
): CallWindowHandle {
  return {
    target,
    session: null,
    state,
    leave: async () => {},
    dispose: async () => {},
    close: async () => {
      for (const off of listeners.splice(0)) off();
    },
  };
}
