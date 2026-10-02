/**
 * Shared sheet/modal/popover behavior (QA-003): Escape closes the topmost
 * open surface, an optional outside click closes it, and an optional focus
 * trap keeps Tab inside. Focus moves into the surface on open and returns to
 * the opener on close.
 *
 * Usage: `<div role="dialog" use:dismissable={{ onclose }}>`.
 */

export interface DismissableOptions {
  /** Called on Escape (and outside click when `outside` is set). */
  onclose?: () => void;
  /** Close on a pointerdown outside the node. Default false. */
  outside?: boolean;
  /** Keep Tab focus inside the node. Default true. */
  trap?: boolean;
  /** Move focus into the node on open. Default true. */
  autofocus?: boolean;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open surfaces, innermost last. Only the top one answers Escape.
const stack: HTMLElement[] = [];

function focusables(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function dismissable(node: HTMLElement, initial: DismissableOptions = {}) {
  let opts = initial;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push(node);

  if (opts.autofocus !== false && !node.contains(document.activeElement)) {
    if (!node.hasAttribute("tabindex")) node.tabIndex = -1;
    const first = focusables(node).find((el) => el.matches("input, textarea, select"));
    (first ?? node).focus({ preventScroll: true });
  }

  function isTop(): boolean {
    return stack[stack.length - 1] === node;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!isTop() || event.defaultPrevented) return;
    if (event.key === "Escape" && opts.onclose) {
      event.preventDefault();
      event.stopPropagation();
      opts.onclose();
      return;
    }
    if (event.key === "Tab" && opts.trap !== false) {
      const items = focusables(node);
      if (items.length === 0) {
        event.preventDefault();
        node.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !node.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function onPointerdown(event: PointerEvent): void {
    if (!opts.outside || !opts.onclose || !isTop()) return;
    const target = event.target;
    if (target instanceof Node && !node.contains(target)) opts.onclose();
  }

  window.addEventListener("keydown", onKeydown);
  document.addEventListener("pointerdown", onPointerdown, true);

  return {
    update(next: DismissableOptions) {
      opts = next;
    },
    destroy() {
      window.removeEventListener("keydown", onKeydown);
      document.removeEventListener("pointerdown", onPointerdown, true);
      const index = stack.lastIndexOf(node);
      if (index >= 0) stack.splice(index, 1);
      if (opener && opener.isConnected && node.contains(document.activeElement)) {
        opener.focus({ preventScroll: true });
      } else if (opener && opener.isConnected && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
    },
  };
}
