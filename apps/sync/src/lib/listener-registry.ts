/**
 * Resilient teardown for Tauri event listeners.
 *
 * `listen()` and `onFocusChanged()` (from `@tauri-apps/api`) each resolve to an
 * unlisten handle. Tauri's own generated unlisten script indexes an internal
 * per-event map — `listeners[eventId].handlerId` — to unregister the callback.
 * When that entry is already gone the property access throws:
 *
 *   TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')
 *
 * The entry can be missing whenever a teardown runs against a stale
 * registration: the same handle unlistened twice, or the webview's listener map
 * was reset (a fast window shutdown / focus-blur churn) while a component's
 * unmount cleanup was still draining its handles. Unguarded, that throw
 * propagates out of the `onMount`/`onDestroy` cleanup that invoked it and
 * aborts the rest of the teardown. It surfaced in production as Sentry
 * HQ-DESKTOP-39 (culprit chunk carrying `@tauri-apps/api` window/event code).
 *
 * The framework unlisten is not idempotent and we can't patch it, so we defend
 * at the boundary: wrap every handle so it runs at most once and can never
 * throw out of teardown.
 */
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Wrap a Tauri unlisten handle so tearing the listener down is idempotent and
 * never throws.
 *
 * The returned function invokes `unlisten` at most once; a second call is a
 * no-op (which is the state Tauri's own script crashes trying to reach). Any
 * error thrown by the underlying handle — including the stale-map `TypeError`
 * above — is swallowed and logged rather than propagated, so a
 * double/stale teardown degrades to a no-op instead of crashing the surface.
 */
export function safeUnlisten(unlisten: UnlistenFn | null | undefined): UnlistenFn {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    try {
      unlisten?.();
    } catch (err) {
      // Already gone — exactly the end state we want. Never let teardown throw.
      console.warn('safeUnlisten: ignoring listener teardown error', err);
    }
  };
}

/**
 * Collects the Tauri unlisten handles registered during one component mount and
 * tears them all down on {@link dispose} — resiliently.
 *
 * Because registration is asynchronous, a handle can arrive after the surface
 * has already been disposed (dev reloads, fast window shutdown). A handle
 * {@link push}ed after disposal is unlistened immediately. Every handle is
 * invoked through {@link safeUnlisten}, so one stale/double teardown can neither
 * throw nor prevent the remaining handles from being released.
 */
export class ListenerRegistry {
  private disposed = false;
  private readonly handlers: UnlistenFn[] = [];

  push(...handlers: UnlistenFn[]): number {
    for (const unlisten of handlers) {
      const safe = safeUnlisten(unlisten);
      if (this.disposed) {
        safe();
      } else {
        this.handlers.push(safe);
      }
    }
    return this.handlers.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unlisten of this.handlers) unlisten();
    this.handlers.length = 0;
  }
}
