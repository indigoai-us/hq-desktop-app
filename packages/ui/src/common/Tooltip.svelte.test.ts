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

  it("reads in the regular weight (owner, 2026-10-14: tooltips are regular, not medium)", () => {
    const style = readFileSync(resolve(process.cwd(), "src/common/Tooltip.svelte"), "utf8").match(/\.tooltip-bubble \{([^}]*)\}/)![1]!;
    expect(style).toMatch(/font-weight: 400;/);
  });
});

describe("Tooltip at a window edge", () => {
  const rect = (left: number, width: number) =>
    ({ left, right: left + width, width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON() {} }) as DOMRect;

  function openNear(triggerLeft: number, triggerWidth: number, bubbleWidth: number): HTMLElement {
    const wrap = render(false);
    wrap.getBoundingClientRect = () => rect(triggerLeft, triggerWidth);
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains("tooltip-bubble") ? rect(0, bubbleWidth) : proto.call(this);
    };
    try {
      wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      flushSync();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = proto;
    }
    return host!.querySelector('[role="tooltip"]') as HTMLElement;
  }

  // Owner, 2026-09: "when it's at the edge and the tooltip will bleed off
  // screen we shouldnt center the tooltip — we should right align".
  it("aligns to the trigger's right edge instead of overhanging the window", () => {
    // 1024px window, a 24px button 10px from the right, a 120px bubble.
    const bubble = openNear(990, 24, 120);
    const centredLeft = 990 + 12 - 60;
    const flushRight = 990 + 24 - 120;
    expect(bubble.style.getPropertyValue("--tooltip-x")).toBe(`${flushRight - centredLeft}px`);
  });

  it("aligns to the trigger's left edge near the left of the window", () => {
    const bubble = openNear(4, 24, 120);
    const centredLeft = 4 + 12 - 60;
    // Left-aligned with the trigger would sit at x=4, inside the 8px margin,
    // so the margin backstop wins.
    expect(bubble.style.getPropertyValue("--tooltip-x")).toBe(`${8 - centredLeft}px`);
  });

  it("stays centred when it fits", () => {
    const bubble = openNear(400, 24, 120);
    expect(bubble.style.getPropertyValue("--tooltip-x")).toBe("");
  });
});
