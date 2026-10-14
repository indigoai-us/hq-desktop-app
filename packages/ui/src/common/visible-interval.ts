/**
 * A fixed-period poll that sleeps while the window is hidden.
 *
 * `setInterval` keeps firing when the window is minimized or closed to the
 * menubar, which spends CPU and network on data nobody can see. This skips
 * ticks while `document.hidden` is true and runs one tick at once when the
 * window is shown again, so the view is fresh the moment it reappears.
 *
 * Returns the stop function; use it as an effect cleanup.
 */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

export interface VisibleIntervalOptions {
  /** Defaults to `document` when one exists; tests pass a fake. */
  visibility?: VisibilitySource | null;
}

export function startVisibleInterval(
  tick: () => void,
  intervalMs: number,
  opts: VisibleIntervalOptions = {},
): () => void {
  const visibility =
    opts.visibility !== undefined ? opts.visibility : typeof document === "undefined" ? null : document;
  let handle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const arm = (): void => {
    if (handle == null) handle = setInterval(tick, intervalMs);
  };
  const disarm = (): void => {
    if (handle != null) clearInterval(handle);
    handle = null;
  };
  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (visibility?.hidden) {
      disarm();
      return;
    }
    if (handle != null) return;
    tick();
    arm();
  };

  if (!visibility?.hidden) arm();
  visibility?.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    stopped = true;
    disarm();
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
