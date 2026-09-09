/**
 * Wires {@link ContinuationDeps} to the native side.
 *
 * `desktop-session-continuation.ts` is written against an interface on purpose:
 * every rule about when continuation runs, what a receipt looks like, and what
 * happens when something fails is decided there, where a unit test can reach
 * it. This file is the adapter — `invoke` calls, one fetch, no decisions — and
 * it is deliberately small because `src-tauri` cannot be compiled on a machine
 * without a GTK/JavaScriptCore toolchain, so anything pushed across that
 * boundary stops being testable.
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
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
  fetch?: typeof tauriFetch;
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
  const httpFetch = options.fetch ?? tauriFetch;
  const storage =
    options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);

  return {
    bridge: bridge(call),
    fetchConfig: async () => {
      const response = await httpFetch(`${context.apiBase}/v1/desktop/onboarding/config`, {
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        // A non-2xx is not a config. Throwing lands on `unavailable`, which is
        // the provider buttons — the screen that ships today.
        throw new Error(`config request failed: ${response.status}`);
      }
      return (await response.json()) as unknown;
    },
    deliver: async (receipt: ContinuationReceipt) => {
      try {
        const response = await httpFetch(`${context.apiBase}${receipt.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(receipt.body),
        });
        return classifyDelivery(response.status);
      } catch {
        // Offline. Keep it queued; it is replayed on the next launch, which is
        // why the queue survives a restart at all.
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
