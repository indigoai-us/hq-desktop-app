// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { menuPortal } from "./portal";

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mountPortal(): {
  node: HTMLElement;
  inner: HTMLElement;
  anchor: HTMLElement;
} {
  const shell = document.createElement("div");
  shell.className = "desktop-shell";
  document.body.appendChild(shell);

  const anchor = document.createElement("button");
  shell.appendChild(anchor);

  const node = document.createElement("div");
  const inner = document.createElement("div");
  node.appendChild(inner);
  shell.appendChild(node);

  const action = menuPortal(node, { anchor, placement: "bottom-end" });
  cleanup = () => action?.destroy?.();
  return { node, inner, anchor };
}

describe("menuPortal re-anchoring", () => {
  /**
   * The listener is capture-phase so a scroll BEHIND the menu re-anchors it.
   * That also catches scrolls inside the menu, and re-anchoring rewrites the
   * panel's own width and offsets on every frame of that scroll. An earlier
   * `place()` also blanked the panel's max-height to measure it, which reset
   * the inner scroller mid-gesture and jammed the filter list partway down.
   * Re-anchoring is measured here by the anchor read every `place()` makes.
   */
  it("does not re-anchor when the menu's own content scrolls", () => {
    const { node, inner, anchor } = mountPortal();
    const before = node.style.top;
    const spy = vi.spyOn(anchor, "getBoundingClientRect");

    inner.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(spy).not.toHaveBeenCalled();
    expect(node.style.top).toBe(before);
  });

  it("still re-anchors when something behind the menu scrolls", () => {
    const { anchor } = mountPortal();
    const behind = document.createElement("div");
    document.querySelector(".desktop-shell")!.appendChild(behind);
    const spy = vi.spyOn(anchor, "getBoundingClientRect");

    behind.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(spy).toHaveBeenCalled();
  });
});
