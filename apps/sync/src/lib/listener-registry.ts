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
 *
 * ## Where that boundary actually reaches
 *
 * {@link safeUnlisten} can only contain a handle that RETURNS its failure — a
 * synchronous throw, or a promise it hands back so we can attach a `catch`.
 * That covers `listen()`, whose handle is `async () => _unlisten(event, id)`.
 *
 * It does NOT cover the framework's *composite* handles. `Window.onFocusChanged`
 * (and `Window.onDragDropEvent`) awaits two `listen()` registrations and returns
 *
 *   () => { unlistenFocus(); unlistenBlur(); }
 *
 * — a synchronous block-bodied arrow evaluating to `undefined`. Both inner calls
 * are async, so each produces a rejecting promise that the arrow discards inside
 * the framework closure, where no app-side wrapper can reach it. Wrapping that
 * composite in `safeUnlisten` is a silent no-op: there is nothing to catch, and
 * both stale-map rejections escape the app as unhandled rejections.
 *
 * That is why HQ-DESKTOP-39 recurred after teardown was already "contained" —
 * the wrapper was applied at the wrong boundary. The fix is to decompose rather
 * than wrap: {@link subscribeWindowFocus} registers the two underlying window
 * events itself, so every handle it owns is a real returning handle that
 * {@link safeUnlisten} can contain. Do not re-introduce `onFocusChanged` at a
 * call site — `__tests__/stories/tauri-composite-listener-handles.test.ts`
 * fails the build if you do.
 */
import type { UnlistenFn } from '@tauri-apps/api/event';

/**
 * Tauri's window focus/blur event names.
 *
 * These mirror `TauriEvent.WINDOW_FOCUS` / `TauriEvent.WINDOW_BLUR` from
 * `@tauri-apps/api/event`, declared as literals on purpose: importing the
 * `TauriEvent` *value* here would force every suite that stubs
 * `@tauri-apps/api/event` (two dozen of them) to re-export it or crash. The
 * equivalence is pinned against the real package in `listener-registry.test.ts`,
 * so an upstream rename fails a test rather than silently subscribing to an
 * event Tauri never emits.
 */
const WINDOW_FOCUS_EVENT = 'tauri://focus';
const WINDOW_BLUR_EVENT = 'tauri://blur';

const wrappedUnlisteners = new WeakMap<UnlistenFn, UnlistenFn>();

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function reportTeardownError(error: unknown): void {
  console.warn('safeUnlisten: ignoring listener teardown error', error);
}

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
  if (!unlisten) return () => {};

  const existing = wrappedUnlisteners.get(unlisten);
  if (existing) return existing;

  let called = false;
  const safe = () => {
    if (called) return;
    called = true;
    try {
      const result: unknown = unlisten();
      if (isThenable(result)) {
        void Promise.resolve(result).catch(reportTeardownError);
      }
    } catch (err) {
      // Already gone — exactly the end state we want. Never let teardown throw.
      reportTeardownError(err);
    }
  };

  wrappedUnlisteners.set(unlisten, safe);
  return safe;
}

/** The focus event handed to a {@link subscribeWindowFocus} handler. */
export interface WindowFocusEvent {
  /** Underlying Tauri event name (`tauri://focus` / `tauri://blur`). */
  event: string;
  /** Tauri's id for the underlying registration. */
  id: number;
  /** `true` when the window gained focus, `false` when it lost focus. */
  payload: boolean;
}

export type WindowFocusHandler = (event: WindowFocusEvent) => void;

/** The slice of `@tauri-apps/api`'s `Window` that {@link subscribeWindowFocus} uses. */
export interface FocusListenableWindow {
  listen<T>(
    event: string,
    handler: (event: { event: string; id: number; payload: T }) => void,
  ): Promise<UnlistenFn>;
}

/**
 * Subscribe to a window's focus changes with a teardown that can be contained.
 *
 * A drop-in replacement for `win.onFocusChanged(handler)`: the handler still
 * receives `{ payload: true }` on focus and `{ payload: false }` on blur, from
 * the same two underlying window events, registered on the same `Window`
 * instance (so the `{ kind: 'Window', label }` target is identical and a
 * secondary window still only hears about itself).
 *
 * The difference is teardown. `onFocusChanged` returns a composite that drops
 * its two inner unlisten promises where nothing can catch them (see the module
 * docstring — this is Sentry HQ-DESKTOP-39). Here each registration is a real
 * `listen()` handle that returns its rejection, so each goes through
 * {@link safeUnlisten} and a stale-map teardown degrades to a logged no-op.
 *
 * The returned teardown is idempotent and never throws.
 */
export async function subscribeWindowFocus(
  win: FocusListenableWindow,
  handler: WindowFocusHandler,
): Promise<UnlistenFn> {
  const focusHandle = await win.listen<unknown>(WINDOW_FOCUS_EVENT, (event) => {
    handler({ ...event, payload: true });
  });

  let blurHandle: UnlistenFn;
  try {
    blurHandle = await win.listen<unknown>(WINDOW_BLUR_EVENT, (event) => {
      handler({ ...event, payload: false });
    });
  } catch (err) {
    // Never leak a half-registered pair: release focus before propagating.
    safeUnlisten(focusHandle)();
    throw err;
  }

  const safeFocus = safeUnlisten(focusHandle);
  const safeBlur = safeUnlisten(blurHandle);

  return () => {
    safeFocus();
    safeBlur();
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
