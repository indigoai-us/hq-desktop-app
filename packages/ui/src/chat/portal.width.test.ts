// @vitest-environment happy-dom
/**
 * A portaled menu is measured at its own width, pinned on the left only.
 * `.chat-popover { right: 0 }` outranked `.chat-scope-menu { right: auto }`,
 * so with `left` set too the panel stretched edge to edge and the company
 * menu opened as wide as the window (owner, 2026-10-22). happy-dom does not
 * lay out, so the stretch is modelled by what offsetWidth reports while the
 * panel is pinned on both sides.
 */
import { afterEach, describe, expect, it } from "vitest";

import { menuPortal } from "./portal";

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

describe("menuPortal width", () => {
  it("measures the panel unstretched, so it keeps its own width", () => {
    const shell = document.createElement("div");
    shell.className = "desktop-shell";
    document.body.appendChild(shell);
    const anchor = document.createElement("button");
    shell.appendChild(anchor);
    anchor.getBoundingClientRect = () =>
      ({ left: 200, right: 270, top: 105, bottom: 131, width: 70, height: 26, x: 200, y: 105, toJSON: () => ({}) }) as DOMRect;

    const node = document.createElement("div");
    // The stylesheet pins it on both sides, as `.chat-popover` does.
    node.style.left = "0px";
    node.style.right = "0px";
    Object.defineProperty(node, "offsetWidth", {
      get: () => (node.style.right === "auto" ? 252 : window.innerWidth),
    });
    Object.defineProperty(node, "offsetHeight", { get: () => 180 });
    shell.appendChild(node);

    const action = menuPortal(node, { anchor, placement: "bottom-start" });
    cleanup = () => action?.destroy?.();

    expect(node.style.width).toBe("252px");
    expect(node.style.left).toBe("200px");
  });
});
