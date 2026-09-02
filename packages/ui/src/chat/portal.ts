/**
 * Shared Svelte actions for the chat overlays.
 *
 * Extracted verbatim from `ChatSidebar.svelte` so the sidebar and
 * `CreateModal.svelte` use ONE implementation. Deliberately not re-exported
 * from `src/index.ts` — these are internal to the chat shell.
 */

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
