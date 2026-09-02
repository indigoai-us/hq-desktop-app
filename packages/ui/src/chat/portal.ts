/**
 * Shared Svelte actions for the chat overlays.
 *
 * Extracted verbatim from `ChatSidebar.svelte` so the sidebar and
 * `CreateModal.svelte` use ONE implementation. Deliberately not re-exported
 * from `src/index.ts` — these are internal to the chat shell.
 */
import {
  placeAnchoredPopover,
  type MenuPlacement,
} from "./popover-placement.js";

export type { MenuPlacement };

export type MenuPortalParams = {
  anchor: HTMLElement | null;
  placement: MenuPlacement;
  /** Filter menu: 360. Other menus omit this and size to content. */
  maxWidth?: number;
  /** Filter menu: 40. When set, width is also capped to rail + this. */
  railOverhang?: number;
  railSelector?: string;
};

/**
 * Portal a node up to the app shell so the centered overlays escape the
 * sidebar's containing block (`.chat-sidebar` sets backdrop-filter +
 * overflow:hidden, which would otherwise trap `position: fixed`). The
 * `.desktop-shell` root has no transform/filter (so `fixed` resolves to the
 * viewport) and carries the `.chat-shell` design tokens (--t1/--hover/…), so
 * the portaled overlay keeps its colors. Scoped styles still apply — Svelte
 * tags the authored node wherever it lives in the DOM.
 */
export function portal(node: HTMLElement) {
  if (typeof document === "undefined") return {};
  const host =
    document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
  host.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

/**
 * Portal a dropdown to `.desktop-shell` and fix-position it on its trigger.
 *
 * Scope / filter / footer menus used to be `position:absolute` inside
 * `.chat-sidebar` (overflow:hidden + backdrop-filter), so they clipped to the
 * rail. Escaping to `.desktop-shell` as `position:fixed` — the same trick
 * `.chat-overlay` uses — lets them paint above the rail. Placement is
 * viewport-aware (titlebar Launch-menu flip/shift): prefer the requested
 * alignment, then shift so the panel stays inside the window with an 8px
 * margin. Re-anchors on scroll/resize.
 */
export function menuPortal(node: HTMLElement, params: MenuPortalParams) {
  if (typeof document === "undefined") return {};
  const host =
    document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
  host.appendChild(node);
  node.style.position = "fixed";
  node.style.margin = "0";
  node.style.boxSizing = "border-box";
  let current = params;

  function place() {
    const anchor = current.anchor;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    // Footer account menu: keep stretching to the rail with an 8px inset.
    if (current.placement === "top-stretch") {
      const gap = 4;
      const inset = 8;
      node.style.top = "auto";
      node.style.bottom = `${window.innerHeight - r.top + gap}px`;
      node.style.left = `${r.left + inset}px`;
      node.style.right = `${window.innerWidth - r.right + inset}px`;
      node.style.width = "auto";
      node.style.maxWidth = "";
      return;
    }
    node.style.width = "auto";
    node.style.maxWidth = "none";
    const rail =
      current.railOverhang != null
        ? anchor.closest(current.railSelector ?? ".chat-sidebar")
        : null;
    const railWidth =
      rail instanceof HTMLElement ? rail.getBoundingClientRect().width : undefined;
    const placed = placeAnchoredPopover({
      anchor: r,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement: current.placement,
      popoverWidth: node.offsetWidth,
      popoverHeight: node.offsetHeight,
      maxWidth: current.maxWidth,
      railWidth,
      railOverhang: current.railOverhang,
    });
    node.style.top = `${placed.top}px`;
    node.style.bottom = "auto";
    node.style.left = `${placed.left}px`;
    node.style.right = "auto";
    if (placed.width > 0) {
      node.style.width = `${placed.width}px`;
      node.style.maxWidth = `${placed.width}px`;
    }
  }

  place();
  const reposition = () => place();
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", reposition, true);
  return {
    update(next: MenuPortalParams) {
      current = next;
      place();
    },
    destroy() {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      node.remove();
    },
  };
}

/**
 * Focus a node as soon as it mounts. The native `autofocus` attribute only
 * fires reliably on the initial document load, not for elements added later
 * (e.g. an overlay opened by a click), so the search palette would open
 * unfocused and swallow the user's first keystrokes. rAF waits for the
 * portal to attach before focusing.
 */
export function focusOnMount(node: HTMLElement) {
  if (typeof requestAnimationFrame === "undefined") {
    node.focus();
    return {};
  }
  const id = requestAnimationFrame(() => node.focus());
  return {
    destroy() {
      cancelAnimationFrame(id);
    },
  };
}
