/**
 * Capture and restore per-destination scroll for in-app history (US-006).
 *
 * Prefer a visible message/event/file identity; fall back to pixel offset.
 * Restore is a bounded retry after layout is ready and must not fight a live
 * transcript that is pinned to the bottom.
 */

import type { NavigationScrollState } from "./navigation-history.js";

export const NAVIGATION_SCROLL_RETRY_LIMIT = 16;
export const NAVIGATION_SCROLL_RETRY_MS = 50;
export const NAVIGATION_STICK_THRESHOLD_PX = 40;

const SCROLLER_SELECTOR = [
  '[data-testid="conversation-thread"]',
  '[data-testid="session-transcript"]',
  '[data-testid="file-preview-pane"]',
  '[data-testid="channel-files-list"]',
].join(",");

function isHtmlElement(value: unknown): value is HTMLElement {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement;
}

function isScroller(el: HTMLElement): boolean {
  const testId = el.getAttribute("data-testid");
  return (
    testId === "conversation-thread" ||
    testId === "session-transcript" ||
    testId === "file-preview-pane" ||
    testId === "channel-files-list"
  );
}

export function findNavigationScroller(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  if (!root) return null;
  if (isHtmlElement(root) && isScroller(root)) return root;
  if (typeof root.querySelector !== "function") return null;
  const found = root.querySelector(SCROLLER_SELECTOR);
  return isHtmlElement(found) ? found : null;
}

function classifyAnchor(
  scroller: HTMLElement,
  el: HTMLElement,
): NavigationScrollState["kind"] {
  if (el.hasAttribute("data-file-key") || el.hasAttribute("data-path")) {
    return "file";
  }
  const scrollerId = scroller.getAttribute("data-testid");
  if (scrollerId === "session-transcript" || el.classList.contains("event-anchor")) {
    return "event";
  }
  return "message";
}

function firstVisibleAnchor(
  scroller: HTMLElement,
): { kind: NavigationScrollState["kind"]; id: string } | null {
  const nodes = scroller.querySelectorAll<HTMLElement>(
    "[data-event-id], [data-file-key], [data-path]",
  );
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  for (const node of nodes) {
    const id =
      node.getAttribute("data-event-id")?.trim() ||
      node.getAttribute("data-file-key")?.trim() ||
      node.getAttribute("data-path")?.trim() ||
      "";
    if (!id) continue;
    const top = node.offsetTop;
    const bottom = top + Math.max(node.offsetHeight, 1);
    if (bottom < viewTop || top > viewBottom) continue;
    return { kind: classifyAnchor(scroller, node), id };
  }
  const first = nodes[0];
  if (!first) return null;
  const id =
    first.getAttribute("data-event-id")?.trim() ||
    first.getAttribute("data-file-key")?.trim() ||
    first.getAttribute("data-path")?.trim() ||
    "";
  if (!id) return null;
  return { kind: classifyAnchor(scroller, first), id };
}

function findAnchor(
  scroller: HTMLElement,
  scroll: NavigationScrollState,
): HTMLElement | null {
  const id = scroll.id?.trim();
  if (!id) return null;
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  if (scroll.kind === "file") {
    const file =
      scroller.querySelector<HTMLElement>(`[data-file-key="${escaped}"]`) ??
      scroller.querySelector<HTMLElement>(`[data-path="${escaped}"]`);
    return file;
  }
  return scroller.querySelector<HTMLElement>(`[data-event-id="${escaped}"]`);
}

export function isScrollNearBottom(
  scroll: NavigationScrollState,
  scroller?: HTMLElement | null,
): boolean {
  if (!scroller) return scroll.kind === "pixel" && scroll.offset <= 0;
  const distance = scroller.scrollHeight - scroll.offset - scroller.clientHeight;
  return distance <= NAVIGATION_STICK_THRESHOLD_PX;
}

/** Snapshot the active leaf scroller. Identity first, pixel fallback. */
export function captureNavigationScroll(
  root: ParentNode | null | undefined,
): NavigationScrollState | null {
  const scroller = findNavigationScroller(root);
  if (!scroller) return null;
  const offset = Math.max(0, Math.round(scroller.scrollTop));
  const identity = firstVisibleAnchor(scroller);
  if (identity) {
    return { kind: identity.kind, id: identity.id, offset };
  }
  return { kind: "pixel", id: null, offset };
}

/**
 * Apply a stored scroll. Returns false when layout or the identity node is
 * not ready yet so the caller can retry.
 */
export function restoreNavigationScroll(
  root: ParentNode | null | undefined,
  scroll: NavigationScrollState,
): boolean {
  const scroller = findNavigationScroller(root);
  if (!scroller) return false;
  const layoutReady = scroller.scrollHeight > 0;
  if (scroll.kind !== "pixel" && scroll.id) {
    if (!layoutReady) return false;
    const anchor = findAnchor(scroller, scroll);
    if (!anchor) return false;
    scroller.scrollTop = anchor.offsetTop;
    return true;
  }
  if (!layoutReady && scroll.offset > 0) return false;
  scroller.scrollTop = scroll.offset;
  return true;
}

/**
 * Track the active scroller's position off the click path.
 *
 * `captureNavigationScroll` reads `scrollTop`/`offsetTop` on the transcript's
 * DOM, and any geometry read forces the browser to flush a pending layout
 * for the whole document before it can answer. Calling it synchronously
 * inside the row-click handler (the old `rememberScroll` in
 * `navigation-controller.ts`) meant every conversation switch paid for a
 * full layout of the *outgoing* conversation's DOM before the new row's
 * highlight or loading state could paint — the click's own tick has to
 * finish before the browser gets a frame, and this reflow ran inside it.
 * On a long transcript that reflow is the "noticeable lag" reported: the
 * result is unaffected by which conversation just got selected, purely a
 * cost of measuring the one being left.
 *
 * This tracker instead samples the scroller on `scroll`/`resize`, throttled
 * to one measurement per animation frame, so the expensive read happens
 * while the user is scrolling (off the critical path) rather than the
 * instant they click. `read()` then just returns the last sample — no DOM
 * access, no forced layout — so it is safe to call from `navigate()`.
 *
 * A sample only describes the destination that was on screen while it was
 * taken. `navigate()`/`traverse()` consume the sample (via `read()`) for the
 * entry being *left*, then commit a new destination. If the new destination
 * renders without ever firing `scroll`/`resize` (a short conversation with
 * no overflow, or one that opens already at its natural position), the old
 * sample would otherwise sit in `last` and get attributed to whichever
 * destination is left *next* — stale state from a conversation two hops
 * back landing on the wrong entry. `invalidate()` is called right after a
 * destination commits: it drops the stale sample and schedules a fresh rAF
 * read of the new destination, so by the time that destination is itself
 * left, `read()` either has its own sample or (if left before the first
 * frame renders) correctly returns null instead of another entry's state.
 */
export function createNavigationScrollTracker(
  readRoot: () => ParentNode | null | undefined,
): {
  read: () => NavigationScrollState | null;
  invalidate: () => void;
  stop: () => void;
} {
  let last: NavigationScrollState | null = null;
  let rafHandle: number | null = null;

  const sample = (): void => {
    rafHandle = null;
    try {
      last = captureNavigationScroll(readRoot());
    } catch {
      /* sampling is best-effort */
    }
  };

  const schedule = (): void => {
    if (rafHandle != null) return;
    rafHandle =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(sample)
        : (setTimeout(sample, 16) as unknown as number);
  };

  const target = typeof document === "undefined" ? null : document;
  target?.addEventListener("scroll", schedule, { capture: true, passive: true });
  target?.defaultView?.addEventListener("resize", schedule, { passive: true });
  // Prime an initial sample so the very first navigate() has something to
  // hand back instead of null.
  schedule();

  return {
    read: () => last,
    // Drop the outgoing destination's sample and queue a fresh one for
    // whatever just became current. Scheduling (not sampling now) keeps this
    // off the commit's own synchronous path — the read happens in the next
    // frame's normal layout pass, after the new destination has rendered.
    invalidate: () => {
      last = null;
      schedule();
    },
    stop: () => {
      if (rafHandle != null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafHandle);
        else clearTimeout(rafHandle);
        rafHandle = null;
      }
      target?.removeEventListener("scroll", schedule, true);
      target?.defaultView?.removeEventListener("resize", schedule);
    },
  };
}

export function scheduleNavigationScrollRestore(
  readRoot: () => ParentNode | null | undefined,
  scroll: NavigationScrollState,
  options?: {
    isCancelled?: () => boolean;
    onDone?: (ok: boolean) => void;
    attempts?: number;
    delayMs?: number;
  },
): () => void {
  const limit = options?.attempts ?? NAVIGATION_SCROLL_RETRY_LIMIT;
  const delayMs = options?.delayMs ?? NAVIGATION_SCROLL_RETRY_MS;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = (): void => {
    timer = undefined;
    if (stopped || options?.isCancelled?.()) {
      options?.onDone?.(false);
      return;
    }
    if (restoreNavigationScroll(readRoot(), scroll)) {
      options?.onDone?.(true);
      return;
    }
    attempts += 1;
    if (attempts >= limit) {
      options?.onDone?.(false);
      return;
    }
    timer = setTimeout(tick, delayMs);
  };

  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
