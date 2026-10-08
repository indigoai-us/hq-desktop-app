/**
 * The app's toast layer is fixed to the lower-right corner of the viewport,
 * which in the shipped app is the window. On the staged desktop the window is
 * smaller than the viewport, so the harness moves that corner onto the staged
 * window through the layer's inset variables. Off stage nothing is set and
 * the layer keeps its own corner.
 */

/** The layer's own gap from the window's edges (ToastStack.svelte). */
export const TOAST_EDGE_GAP = 16;

export interface ToastInsets {
  right: number;
  bottom: number;
}

/** Insets that put the toast corner 16px inside the window's lower right. */
export function toastInsetsFor(
  win: { right: number; bottom: number },
  viewport: { width: number; height: number },
): ToastInsets {
  return {
    right: Math.max(0, Math.round(viewport.width - win.right)) + TOAST_EDGE_GAP,
    bottom: Math.max(0, Math.round(viewport.height - win.bottom)) + TOAST_EDGE_GAP,
  };
}

/** Svelte action for the staged window: keeps the toast corner on it. */
export function pinToastsToWindow(node: HTMLElement, enabled: boolean) {
  const root = document.documentElement;
  let frame = 0;
  const apply = () => {
    frame = 0;
    const r = node.getBoundingClientRect();
    const insets = toastInsetsFor(r, { width: window.innerWidth, height: window.innerHeight });
    root.style.setProperty("--toast-right-inset", `${insets.right}px`);
    root.style.setProperty("--toast-bottom-inset", `${insets.bottom}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const clear = () => {
    root.style.removeProperty("--toast-right-inset");
    root.style.removeProperty("--toast-bottom-inset");
  };
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  if (enabled) {
    apply();
    observer?.observe(node);
    window.addEventListener("resize", schedule);
  }
  return {
    destroy() {
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      if (enabled) clear();
    },
  };
}
