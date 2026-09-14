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
