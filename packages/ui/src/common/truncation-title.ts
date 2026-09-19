/**
 * Show a native tooltip on a text element ONLY when its text is visually
 * truncated (ellipsized), and then show the full, untruncated value.
 *
 * A sub-label that fits already reads in full on screen, so a `title` holding
 * the same string is noise: hovering the greyed email next to a name popped a
 * tooltip containing that identical email.
 *
 * The check is measured (`scrollWidth > clientWidth`), never a character-count
 * guess, and is re-run when the element resizes and again right before a
 * tooltip could appear (pointer enter / focus), because the sidebar width is
 * user-draggable.
 */
export function titleWhenTruncated(node: HTMLElement, text?: string | null) {
  let value = text ?? node.textContent ?? "";

  const apply = () => {
    const full = value.trim();
    const truncated = node.scrollWidth > node.clientWidth;
    if (full && truncated) node.setAttribute("title", full);
    else node.removeAttribute("title");
  };

  apply();

  const observer =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
  observer?.observe(node);

  node.addEventListener("pointerenter", apply);
  node.addEventListener("mouseenter", apply);
  node.addEventListener("focusin", apply);

  return {
    update(next?: string | null) {
      value = next ?? node.textContent ?? "";
      apply();
    },
    destroy() {
      observer?.disconnect();
      node.removeEventListener("pointerenter", apply);
      node.removeEventListener("mouseenter", apply);
      node.removeEventListener("focusin", apply);
    },
  };
}
