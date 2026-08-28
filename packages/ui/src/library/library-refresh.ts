/**
 * Keep a Library surface fresh.
 *
 * The desktop Library reads workers/skills from the local HQ folder once, when
 * a page mounts (`LibraryPage` / `CompanyLibraryPanel`). Without a refresh
 * signal a worker created in another tool — e.g. `/newworker` in Claude Code,
 * or hand-authoring a `worker.yaml` — does not appear until the page is
 * remounted. That "I made a worker but it isn't in the library" gap is what
 * this module closes.
 *
 * We re-fetch on two signals:
 *   - the window regaining focus — the primary trigger: the user creates a
 *     worker elsewhere, then switches back to the app, and
 *   - `sync:complete` — a worker authored by a teammate that arrives via
 *     cloud sync.
 *
 * PORT NOTE (packages/ui purity): the desktop-alt original imported Tauri's
 * `listen` + `getCurrentWindow` directly. Here the host injects those seams
 * via {@link LibraryRefreshHost}; the desktop app wires them to Tauri, the web
 * app wires them to `window` focus events / mesh sync notifications (or omits
 * the surface). All of the HQ-DESKTOP-39 teardown containment below is
 * preserved verbatim: every handle is a real returning handle wrapped in
 * `safeUnlisten`, so a stale/double teardown degrades to a logged no-op and
 * never throws or leaks an unhandled rejection.
 *
 * Returns a single unlisten that tears down both subscriptions.
 */

/** An unlisten handle. May return a promise whose rejection we must contain. */
export type UnlistenFn = () => void;

/** The slice of a window that focus subscription uses (Tauri `Window.listen`). */
export interface FocusListenableWindow {
  listen(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<UnlistenFn>;
}

/** Host seam replacing the direct Tauri imports of the desktop-alt original. */
export interface LibraryRefreshHost {
  /** App-level event subscription (Tauri `listen`, or a web mesh bridge). */
  listen(
    event: string,
    handler: (event: { payload: unknown }) => void,
  ): Promise<UnlistenFn>;
  /** The current window (only `listen` is used — focus/blur events). */
  getCurrentWindow(): FocusListenableWindow;
}

// Tauri's window focus/blur event names (literals on purpose; see the
// desktop-alt listener-registry docs — importing the enum breaks test stubs).
const WINDOW_FOCUS_EVENT = "tauri://focus";
const WINDOW_BLUR_EVENT = "tauri://blur";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
}

function reportTeardownError(error: unknown): void {
  console.warn("safeUnlisten: ignoring listener teardown error", error);
}

/**
 * Wrap an unlisten handle so tearing the listener down is idempotent and never
 * throws. Any error thrown by the underlying handle — including Tauri's
 * stale-map `TypeError` (Sentry HQ-DESKTOP-39) — is swallowed and logged.
 */
export function safeUnlisten(
  unlisten: UnlistenFn | null | undefined,
): UnlistenFn {
  if (!unlisten) return () => {};
  let called = false;
  return () => {
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
}

/**
 * Subscribe to a window's focus changes with a teardown that can be contained.
 *
 * Deliberately NOT the framework's `onFocusChanged` composite — that drops its
 * two inner unlisten promises where nothing can catch them (HQ-DESKTOP-39).
 * Each registration here is a real `listen()` handle that returns its
 * rejection, so each goes through {@link safeUnlisten}.
 */
export async function subscribeWindowFocus(
  win: FocusListenableWindow,
  handler: (event: { payload: boolean }) => void,
): Promise<UnlistenFn> {
  const focusHandle = await win.listen(WINDOW_FOCUS_EVENT, () => {
    handler({ payload: true });
  });

  let blurHandle: UnlistenFn;
  try {
    blurHandle = await win.listen(WINDOW_BLUR_EVENT, () => {
      handler({ payload: false });
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

export async function subscribeLibraryRefresh(
  host: LibraryRefreshHost,
  onRefresh: () => void,
): Promise<UnlistenFn> {
  // `subscribeWindowFocus`, not `onFocusChanged` — the framework composite
  // discards the unlisten promises this surface has to be able to contain.
  const unlistenFocus = await subscribeWindowFocus(
    host.getCurrentWindow(),
    ({ payload: focused }) => {
      // Only a gained focus is a refresh signal; losing focus is a no-op.
      if (focused) onRefresh();
    },
  );

  const unlistenSync = await host.listen("sync:complete", () => {
    onRefresh();
  });

  // Each handle is torn down through `safeUnlisten` so a stale/double
  // teardown of one subscription can neither throw nor skip the other.
  const safeFocus = safeUnlisten(unlistenFocus);
  const safeSync = safeUnlisten(unlistenSync);
  return () => {
    safeFocus();
    safeSync();
  };
}
