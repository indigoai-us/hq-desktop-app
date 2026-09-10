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
 * sidebar's clipping box (`.chat-sidebar` sets overflow:hidden, which would
 * otherwise crop an absolutely-positioned overlay). The
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
 * `.chat-sidebar` (overflow:hidden), so they clipped to the rail. Escaping to `.desktop-shell` as `position:fixed` — the same trick
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

  /**
   * `position: fixed` resolves against the viewport only when no ancestor
   * establishes a containing block — but any `filter`, `transform` or
   * `backdrop-filter` above the node does, and the window material sets one.
   * Offsets written in viewport coordinates then land shifted by the frame's
   * own origin, which is what left the footer menu short of the rail. Pin the
   * node to its containing block's corners and read back where that lands: the
   * resulting rect IS the containing block in viewport space.
   */
  function containingBlock(): DOMRect {
    const saved = {
      top: node.style.top,
      right: node.style.right,
      bottom: node.style.bottom,
      left: node.style.left,
      width: node.style.width,
      height: node.style.height,
      maxWidth: node.style.maxWidth,
      maxHeight: node.style.maxHeight,
      minWidth: node.style.minWidth,
      minHeight: node.style.minHeight,
    };
    node.style.top = "0px";
    node.style.right = "0px";
    node.style.bottom = "0px";
    node.style.left = "0px";
    node.style.width = "auto";
    node.style.height = "auto";
    // The authored `max-height` would otherwise clip the probe and report a
    // containing block ~280px tall, which is how the footer menu ended up
    // anchored hundreds of pixels below the rail.
    node.style.maxWidth = "none";
    node.style.maxHeight = "none";
    node.style.minWidth = "0";
    node.style.minHeight = "0";
    const rect = node.getBoundingClientRect();
    Object.assign(node.style, saved);
    return rect;
  }

  function place() {
    const anchor = current.anchor;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const cb = containingBlock();
    // Footer account menu: stretch across the rail, not across the footer row.
    // The concept insets its user panel 10px from the sidebar's own edges
    // (280 - 20 = 260 wide); measuring from the footer instead inherited the
    // rail's 14px padding on top of that and came out 24px narrow.
    if (current.placement === "top-stretch") {
      const gap = 4;
      const railEl = anchor.closest(current.railSelector ?? ".chat-sidebar");
      const stretchTo =
        railEl instanceof HTMLElement ? railEl.getBoundingClientRect() : r;
      const inset = railEl instanceof HTMLElement ? 10 : 8;
      node.style.top = "auto";
      node.style.bottom = `${cb.bottom - r.top + gap}px`;
      node.style.left = `${stretchTo.left + inset - cb.left}px`;
      node.style.right = `${cb.right - stretchTo.right + inset}px`;
      node.style.width = "auto";
      node.style.maxWidth = "";
      return;
    }
    // Measure the menu at the width its own stylesheet asks for. Forcing
    // `width: auto` inline used to beat the authored `width` and, with
    // `.chat-popover { right: 0 }` still in play, stretched the panel from its
    // anchor to the far edge of the shell before it was ever measured.
    node.style.width = "";
    node.style.maxWidth = "none";
    node.style.right = "auto";
    node.style.bottom = "auto";
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
    node.style.top = `${placed.top - cb.top}px`;
    node.style.bottom = "auto";
    node.style.left = `${placed.left - cb.left}px`;
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
