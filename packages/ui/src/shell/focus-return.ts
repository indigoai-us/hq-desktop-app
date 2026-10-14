/**
 * Popover focus handling (console-rail US-039). On mount, moves focus to the
 * first focusable control inside the popover so keyboard users land in it;
 * on destroy, returns focus to whatever opened it (the rail button).
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function focusReturn(node: HTMLElement): { destroy: () => void } {
  const opener =
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const first = node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
  first.focus({ preventScroll: true });
  return {
    destroy() {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    },
  };
}
