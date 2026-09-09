/**
 * Wires {@link ContinuationDeps} to the native side.
 *
 * `desktop-session-continuation.ts` is written against an interface on purpose:
 * every rule about when continuation runs, what a receipt looks like, and what
 * happens when something fails is decided there, where a unit test can reach
 * it. This file is the adapter — `invoke` calls, no decisions — and it is
 * deliberately small because `src-tauri` cannot be compiled on a machine
 * without a GTK/JavaScriptCore toolchain, so anything pushed across that
 * boundary stops being testable.
 *
 * ## Why the HTTP is native
 *
 * The config read and the receipt POST used to run here through the HTTP
 * plugin. That worked in the compact popover and silently did not work in the
 * expanded desktop window: `capabilities/desktop-alt.json` grants no
 * `http:default`, so the request was denied, the rollout resolved to
 * unavailable, and continuation could never run on the surface
 * `hq-desktop://signin` opens. Widening that capability would have been the
 * wrong repair — it is deliberately minimal — so both calls moved into Rust,
 * where they need no webview permission and the renderer cannot name a URL.
 * The status still comes back here, because deciding what a status *means* is
 * a rule, and rules live where the tests are.
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  ContinuationBridge,
  ContinuationDeps,
  ContinuationPlatform,
  ContinuationReceipt,
  DeliveryResult,
  VerifiedIdentity,
} from './desktop-session-continuation';

/** What the native side knows and the renderer cannot work out for itself. */
export interface ContinuationContext {
  installAttemptId: string;
  appVersion: string;
  apiBase: string;
}

/**
 * A Tauri command call.
 *
 * Deliberately non-generic. `invoke`'s own signature is generic in its return
 * type, which no test double can satisfy without a cast — and a cast in every
 * test is a cast nobody reads. Narrowing to `unknown` here moves the one cast
 * into this file, where it is next to the command name it belongs to.
 */
export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Injection seam. Real code passes nothing; tests pass everything. */
export interface ContinuationTauriOptions {
  invoke?: InvokeFn;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now?: () => number;
  newId?: () => string;
  platform?: ContinuationPlatform;
}

/**
 * Ask the native side for the installation id, build version, and API base.
 *
 * `null` means continuation does not run. The native side answers `null` when
 * it cannot resolve a stable installation id, and any error here is treated the
 * same way — an adapter that guessed would produce a machine that lands in a
 * different rollout bucket on every launch.
 */
export async function loadContinuationContext(
  options: ContinuationTauriOptions = {},
): Promise<ContinuationContext | null> {
  const call: InvokeFn = options.invoke ?? invoke;
  try {
    const context = (await call('desktop_continuation_context')) as ContinuationContext | null;
    if (!context) return null;
    if (
      typeof context.installAttemptId !== 'string' ||
      context.installAttemptId.trim() === '' ||
      typeof context.appVersion !== 'string' ||
      typeof context.apiBase !== 'string' ||
      context.apiBase.trim() === ''
    ) {
      return null;
    }
    return {
      installAttemptId: context.installAttemptId,
      appVersion: context.appVersion,
      apiBase: context.apiBase.replace(/\/+$/, ''),
    };
  } catch {
    return null;
  }
}

function bridge(call: InvokeFn): ContinuationBridge {
  return {
    mayStart: async () =>
      (await call('desktop_continuation_may_start')) as string | null,
    start: async () => {
      // The renderer passes no state, verifier, or nonce — it never had any.
      // Those exist only in native memory for the life of one attempt.
      const started = (await call('desktop_continuation_start')) as { attemptId: string };
      return { attemptId: started.attemptId };
    },
    awaitIdentity: async ({ attemptId }) =>
      (await call('desktop_continuation_await_identity', { attemptId })) as VerifiedIdentity,
    confirm: async ({ attemptId }) => {
      await call('desktop_continuation_confirm', { attemptId });
    },
    cancel: async ({ attemptId }) => {
      await call('desktop_continuation_cancel', { attemptId });
    },
  };
}

/**
 * Classify a receipt delivery.
 *
 * The three outcomes are not cosmetic. `retry` keeps a receipt queued and
 * replayed byte for byte, because the backend derives its idempotency key from
 * the timestamp the client sent — a receipt that re-stamped its own clock on
 * retry would be counted twice, and the funnel numbers this feature exists to
 * fix would be the thing it broke. `rejected` drops the receipt: a 4xx means
 * this build is sending something the backend will never accept, and retrying
 * forever would only fill the queue.
 */
export function classifyDelivery(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return 'recorded';
  if (status === 429 || status >= 500) return 'retry';
  return 'rejected';
}

/**
 * Build the dependency bundle for one session.
 *
 * Nothing here reads a credential, and nothing here can: the anonymous routes
 * reject an identity field, and the authenticated ones are called from Rust
 * with a bearer token the renderer never sees.
 */
export function continuationDeps(
  context: ContinuationContext,
  options: ContinuationTauriOptions = {},
): ContinuationDeps {
  const call: InvokeFn = options.invoke ?? invoke;
  const storage =
    options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);

  return {
    bridge: bridge(call),
    fetchConfig: async () =>
      // A native error — offline, non-2xx, unreadable body — propagates and
      // lands on `unavailable`, which is the provider buttons, the screen that
      // ships today. There is nothing here that could read a non-config as a
      // config, because there is nothing here that reads at all.
      (await call('desktop_continuation_config')) as unknown,
    deliver: async (receipt: ContinuationReceipt) => {
      try {
        const status = (await call('desktop_continuation_deliver', {
          // Sent verbatim. The native side resolves the path against a
          // two-entry allowlist and refuses anything else, so this is a
          // choice of *which receipt*, never of where it goes.
          path: receipt.path,
          body: receipt.body,
        })) as number;
        return classifyDelivery(status);
      } catch {
        // Offline, or a path the native side refused. Keep it queued; it is
        // replayed on the next launch, which is why the queue survives a
        // restart at all.
        return 'retry';
      }
    },
    storage: storage ?? {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    now: options.now ?? (() => Date.now()),
    newId: options.newId ?? (() => crypto.randomUUID()),
    installAttemptId: context.installAttemptId,
    appVersion: context.appVersion,
    platform: options.platform ?? (navigator.userAgent.includes('Win') ? 'windows' : 'mac'),
  };
}
