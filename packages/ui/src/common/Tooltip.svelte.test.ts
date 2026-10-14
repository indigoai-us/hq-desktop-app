// @vitest-environment happy-dom

/**
 * Tooltip regressions:
 * - `suppressed` silences the bubble while the trigger's menu is open, so it
 *   never covers the first row of the menu it just opened.
 * - Near a window edge the bubble flips to edge alignment with its trigger
 *   instead of running off the window; `align` still sets the preference.
 * - Layering: a tooltip never sits on top of the menu its own control opened
 *   (the Launch tooltip stayed over the open Launch menu).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";

import Tooltip from "./Tooltip.svelte";

type Rect = { left: number; right: number };

function domRect({ left, right }: Rect): DOMRect {
  return {
    left,
    right,
    top: 0,
    bottom: 24,
    x: left,
    y: 0,
    width: right - left,
    height: 24,
    toJSON: () => ({}),
  } as DOMRect;
}

const WINDOW_WIDTH = 1000;
const BUBBLE_WIDTH = 200;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let originalInnerWidth: number;
let triggerRect: Rect;

const trigger = createRawSnippet((describedBy: () => string) => ({
  render: () => `<button type="button" data-testid="trigger">x</button>`,
  setup: (el) => {
    // Keep the attribute live, as a real `aria-describedby={...}` would be.
    $effect(() => {
      el.setAttribute("aria-describedby", describedBy());
    });
  },
}));

beforeEach(() => {
  originalInnerWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: WINDOW_WIDTH,
  });
  triggerRect = { left: 480, right: 520 };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("tooltip-bubble")) {
        return domRect({ left: 0, right: BUBBLE_WIDTH });
      }
      if (this.classList.contains("tooltip-wrap")) return domRect(triggerRect);
      return domRect({ left: 0, right: 0 });
    },
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalInnerWidth,
  });
});

function mountTooltip(props: Record<string, unknown>): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Tooltip, {
    target: host,
    props: { label: "Describe me", trigger, ...props } as never,
  });
  flushSync();
}

async function focusTrigger(): Promise<void> {
  host
    .querySelector('[data-testid="trigger"]')!
    .dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  flushSync();
  await tick();
}

const bubble = () =>
  host.querySelector<HTMLElement>('[data-testid="tooltip-bubble"]');
const nudge = () => bubble()?.style.getPropertyValue("--tooltip-nudge") ?? "";

describe("Tooltip suppressed", () => {
  it("hides the bubble and drops aria-describedby while suppressed", async () => {
    const props = $state({ suppressed: false });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(Tooltip, {
      target: host,
      props: {
        label: "Open your HQ folder in an AI tool",
        trigger,
        get suppressed() {
          return props.suppressed;
        },
      } as never,
    });
    flushSync();

    await focusTrigger();
    expect(bubble()).toBeTruthy();

    // The trigger opened its menu: the bubble must get out of the way.
    props.suppressed = true;
    flushSync();
    expect(bubble()).toBeNull();
    expect(
      host.querySelector('[data-testid="trigger"]')!.getAttribute(
        "aria-describedby",
      ),
    ).toBe("");

    // Hover/focus while the menu is open must not bring it back.
    await focusTrigger();
    host
      .querySelector(".tooltip-wrap")!
      .dispatchEvent(new PointerEvent("pointerenter"));
    await new Promise((r) => setTimeout(r, 450));
    flushSync();
    expect(bubble()).toBeNull();

    // Menu closed: the tooltip works again on the next focus.
    props.suppressed = false;
    flushSync();
    await focusTrigger();
    expect(bubble()).toBeTruthy();
  });
});

describe("Tooltip window edges", () => {
  it("stays centred with no nudge when it fits", async () => {
    mountTooltip({});
    await focusTrigger();
    expect(bubble()).toBeTruthy();
    expect(nudge()).toBe("");
  });

  it("right-aligns to the trigger instead of running off the right edge", async () => {
    // Centred would be 830..1030 in a 1000px window; edge-aligned is 760..960.
    triggerRect = { left: 900, right: 960 };
    mountTooltip({});
    await focusTrigger();
    expect(nudge()).toBe("-70px");
  });

  it("left-aligns to the trigger instead of running off the left edge", async () => {
    // Centred would be -75..125; edge-aligned is 10..210.
    triggerRect = { left: 10, right: 40 };
    mountTooltip({});
    await focusTrigger();
    expect(nudge()).toBe("85px");
  });

  it("keeps an 8px window margin when the trigger itself hugs the edge", async () => {
    // Right-aligned would end at 1000; the backstop pulls it to 792..992.
    triggerRect = { left: 970, right: 1000 };
    mountTooltip({});
    await focusTrigger();
    expect(nudge()).toBe("-93px");
  });

  it("honours align=end when it fits", async () => {
    triggerRect = { left: 900, right: 960 };
    mountTooltip({ align: "end" });
    await focusTrigger();
    expect(bubble()!.classList.contains("align-end")).toBe(true);
    expect(nudge()).toBe("");
  });

  it("flips an align=start bubble to the trigger's right edge near the right of the window", async () => {
    // Start-aligned would be 900..1100; edge-aligned is 760..960.
    triggerRect = { left: 900, right: 960 };
    mountTooltip({ align: "start" });
    await focusTrigger();
    expect(bubble()!.classList.contains("align-start")).toBe(true);
    expect(nudge()).toBe("-140px");
  });
});

describe("Tooltip window edges (rail)", () => {
  it("never nudges a right-side rail bubble", async () => {
    triggerRect = { left: 0, right: 40 };
    mountTooltip({ side: "right" });
    await focusTrigger();
    expect(bubble()!.classList.contains("side-right")).toBe(true);
    expect(nudge()).toBe("");
  });
});

function renderExpandable(expanded: boolean): HTMLElement {
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
    const wrap = renderExpandable(false);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(host.querySelector('[role="tooltip"]')).not.toBeNull();
  });

  it("stays hidden while the control's menu is open", () => {
    const wrap = renderExpandable(true);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("hides when the control is pressed", () => {
    const wrap = renderExpandable(false);
    wrap.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    flushSync();
    wrap.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });
});
