/**
 * Shared sheet/modal/popover behavior (QA-003): Escape closes the topmost
 * open surface, an optional outside click closes it, and an optional focus
 * trap keeps Tab inside. Focus moves into the surface on open and returns to
 * the opener on close.
 *
 * Usage: `<div role="dialog" use:dismissable={{ onclose }}>`.
 *
 * QA-088: one document-level keydown handler serves the whole overlay stack.
 * Escape goes to the topmost surface only and stops there, so a nested picker
 * never dismisses the form that hosts it, and window-level Escape handlers on
 * the page underneath do not fire while a stacked surface is open.
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

interface Entry {
  node: HTMLElement;
  keydown: (event: KeyboardEvent) => void;
}

// Open surfaces, innermost last. Only the top one answers Escape.
const stack: Entry[] = [];

function onDocumentKeydown(event: KeyboardEvent): void {
  const top = stack[stack.length - 1];
  if (top) top.keydown(event);
}

// Keys dispatched straight at the window never pass through the document.
function onWindowKeydown(event: KeyboardEvent): void {
  if (!(event.target instanceof Node)) onDocumentKeydown(event);
}

/** Number of open stacked surfaces (tests and diagnostics). */
export function overlayDepth(): number {
  return stack.length;
}

function focusables(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("inert") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function dismissable(node: HTMLElement, initial: DismissableOptions = {}) {
  let opts = initial;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  if (opts.autofocus !== false && !node.contains(document.activeElement)) {
    if (!node.hasAttribute("tabindex")) node.tabIndex = -1;
    const first = focusables(node).find((el) => el.matches("input, textarea, select"));
    (first ?? node).focus({ preventScroll: true });
  }

  function isTop(): boolean {
    return stack[stack.length - 1]?.node === node;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
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

  const entry: Entry = { node, keydown: onKeydown };
  if (stack.length === 0) {
    document.addEventListener("keydown", onDocumentKeydown);
    window.addEventListener("keydown", onWindowKeydown);
  }
  stack.push(entry);
  document.addEventListener("pointerdown", onPointerdown, true);

  return {
    update(next: DismissableOptions) {
      opts = next;
    },
    destroy() {
      document.removeEventListener("pointerdown", onPointerdown, true);
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) {
        document.removeEventListener("keydown", onDocumentKeydown);
        window.removeEventListener("keydown", onWindowKeydown);
      }
      if (opener && opener.isConnected && node.contains(document.activeElement)) {
        opener.focus({ preventScroll: true });
      } else if (opener && opener.isConnected && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
    },
  };
}
