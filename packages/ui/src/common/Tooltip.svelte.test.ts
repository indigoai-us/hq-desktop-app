// @vitest-environment happy-dom

// Tooltip layering contract: a tooltip must never sit on top of the menu its
// own control opened (the Launch tooltip stayed over the open Launch menu).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, unmount } from "svelte";

import Tooltip from "./Tooltip.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(expanded: boolean): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Tooltip, {
    target: host,
    props: {
      label: "Launch",
      trigger: createRawSnippet((id: () => string) => ({
        render: () =>
          `<button aria-describedby="${id()}" aria-expanded="${expanded}">L</button>`,
      })),
    } as never,
  });
  flushSync();
  return host.querySelector(".tooltip-wrap") as HTMLElement;
}

describe("Tooltip layering", () => {
  it("shows on focus when the control is closed", () => {
    const wrap = render(false);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(host?.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("stays hidden while the control's menu is open", () => {
    const wrap = render(true);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(host?.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("hides when the control is pressed", () => {
    const wrap = render(false);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    wrap.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(host?.querySelector('[role="tooltip"]')).toBeNull();
  });
});

describe("Tooltip bubble text", () => {
  it("wraps a long label inside the bubble instead of running past its edge (regression: the Daily Brief rail tooltip bled off)", () => {
    const style = readFileSync(resolve(process.cwd(), "src/common/Tooltip.svelte"), "utf8").match(/\.tooltip-bubble \{([^}]*)\}/)![1]!;
    expect(style).toMatch(/width: max-content/);
    expect(style).toMatch(/max-width: \d+px/);
    expect(style).toMatch(/white-space: normal/);
    expect(style).not.toMatch(/white-space: nowrap/);
  });
});
