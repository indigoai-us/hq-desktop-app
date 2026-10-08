// @vitest-environment happy-dom

/**
 * The emoji picker must measure its collisions against the pane that clips
 * it, not the window. Inside the message pane (`overflow: hidden/auto`) the
 * trigger sits at a message's right edge, well inside a much wider window, so
 * a window-only check never flipped and half the grid was cut off.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { mount, tick, unmount } from "svelte";

import EmojiPicker from "./EmojiPicker.svelte";

type Box = { top: number; right: number; bottom: number; left: number };

function rect({ top, right, bottom, left }: Box): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let originalInnerWidth: number;
const boxes = new Map<Element, Box>();
let pickerBox: Box;

beforeEach(() => {
  originalInnerWidth = window.innerWidth;
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1200,
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("emoji-picker")) return rect(pickerBox);
      const box = boxes.get(this);
      return rect(box ?? { top: 0, right: 0, bottom: 0, left: 0 });
    },
  );
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  boxes.clear();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: originalInnerWidth,
  });
});

async function mountPicker(target: HTMLElement): Promise<HTMLElement> {
  component = mount(EmojiPicker, {
    target,
    props: { onpick: () => {}, onclose: () => {} },
  });
  await tick();
  await tick();
  const el = target.querySelector<HTMLElement>(".emoji-picker");
  if (!el) throw new Error("picker did not render");
  return el;
}

describe("EmojiPicker placement", () => {
  it("flips below and right-aligns when the clipping message pane would cut it off", async () => {
    // A scrolling pane from x=0..500, y=100..700, inside a 1200px window.
    host = document.createElement("div");
    host.style.overflow = "hidden";
    boxes.set(host, { top: 100, right: 500, bottom: 700, left: 0 });
    const row = document.createElement("div");
    host.appendChild(row);
    document.body.appendChild(host);

    // Opened above-left: pokes above the pane's top and past its right edge,
    // yet sits comfortably inside the window.
    pickerBox = { top: 60, right: 640, bottom: 150, left: 420 };

    const picker = await mountPicker(row);
    expect(picker.classList.contains("place-below")).toBe(true);
    expect(picker.classList.contains("align-right")).toBe(true);
  });

  it("treats overflow-y: auto scroll containers as clipping too", async () => {
    host = document.createElement("div");
    host.style.overflowY = "auto";
    boxes.set(host, { top: 0, right: 500, bottom: 700, left: 0 });
    document.body.appendChild(host);

    pickerBox = { top: 300, right: 640, bottom: 390, left: 420 };

    const picker = await mountPicker(host);
    expect(picker.classList.contains("align-right")).toBe(true);
    expect(picker.classList.contains("place-below")).toBe(false);
  });

  it("stays put when it fits inside the clipping pane", async () => {
    host = document.createElement("div");
    host.style.overflow = "hidden";
    boxes.set(host, { top: 100, right: 900, bottom: 700, left: 0 });
    document.body.appendChild(host);

    pickerBox = { top: 300, right: 640, bottom: 390, left: 420 };

    const picker = await mountPicker(host);
    expect(picker.classList.contains("place-below")).toBe(false);
    expect(picker.classList.contains("align-right")).toBe(false);
  });

  it("falls back to the viewport when no ancestor clips", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);

    pickerBox = { top: 4, right: 1250, bottom: 94, left: 1030 };

    const picker = await mountPicker(host);
    expect(picker.classList.contains("place-below")).toBe(true);
    expect(picker.classList.contains("align-right")).toBe(true);
  });

  it("opens on the roomier side and caps its height when neither side fits (short thread pane)", async () => {
    // ~204px thread pane (1440x460 window): the grid needs 148px, but the
    // trigger leaves 88px above and 64px below. It must not drop downward onto
    // the composer showing one row; it opens above and scrolls inside.
    host = document.createElement("div");
    host.style.overflowY = "auto";
    boxes.set(host, { top: 100, right: 900, bottom: 304, left: 0 });
    const trigger = document.createElement("span");
    trigger.style.position = "relative";
    boxes.set(trigger, { top: 200, right: 640, bottom: 228, left: 600 });
    host.appendChild(trigger);
    document.body.appendChild(host);

    pickerBox = { top: 48, right: 820, bottom: 196, left: 600 };

    const picker = await mountPicker(trigger);
    expect(picker.classList.contains("place-below")).toBe(false);
    expect(picker.classList.contains("capped")).toBe(true);
    // roomAbove = triggerTop(200) - gap(4) - (paneTop(100) + edge(8)) = 88.
    expect(picker.style.maxHeight).toBe("88px");
  });

  it("drops below with a capped height when below is the roomier side", async () => {
    host = document.createElement("div");
    host.style.overflowY = "auto";
    boxes.set(host, { top: 100, right: 900, bottom: 304, left: 0 });
    const trigger = document.createElement("span");
    trigger.style.position = "relative";
    boxes.set(trigger, { top: 130, right: 640, bottom: 158, left: 600 });
    host.appendChild(trigger);
    document.body.appendChild(host);

    pickerBox = { top: -22, right: 820, bottom: 126, left: 600 };

    const picker = await mountPicker(trigger);
    expect(picker.classList.contains("place-below")).toBe(true);
    // roomBelow = paneBottom(304) - edge(8) - (triggerBottom(158) + gap(4)).
    expect(picker.style.maxHeight).toBe("134px");
  });

  it("does not cap its height when the chosen side fits the whole grid", async () => {
    host = document.createElement("div");
    host.style.overflowY = "auto";
    boxes.set(host, { top: 0, right: 900, bottom: 700, left: 0 });
    const trigger = document.createElement("span");
    boxes.set(trigger, { top: 400, right: 640, bottom: 428, left: 600 });
    host.appendChild(trigger);
    document.body.appendChild(host);

    pickerBox = { top: 248, right: 820, bottom: 396, left: 600 };

    const picker = await mountPicker(trigger);
    expect(picker.classList.contains("place-below")).toBe(false);
    expect(picker.classList.contains("capped")).toBe(false);
    expect(picker.style.maxHeight).toBe("");
  });

  it("takes focus without scrolling the message list", async () => {
    // A plain focus() scrolled the thread ~80px to reveal the picker and
    // raised the "Jump to latest" pill over message text.
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    const proto = HTMLElement.prototype as { scrollIntoView?: unknown };
    const originalScrollIntoView = proto.scrollIntoView;
    const scrollIntoView = vi.fn();
    proto.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      proto.scrollIntoView = originalScrollIntoView;
    });
    host = document.createElement("div");
    host.style.overflowY = "auto";
    boxes.set(host, { top: 0, right: 900, bottom: 700, left: 0 });
    document.body.appendChild(host);
    pickerBox = { top: 248, right: 820, bottom: 396, left: 600 };

    const picker = await mountPicker(host);
    const pickerFocus = focus.mock.calls.filter(
      (_, i) => focus.mock.contexts[i] === picker,
    );
    expect(pickerFocus.length).toBeGreaterThan(0);
    for (const args of pickerFocus) {
      expect(args[0]).toEqual({ preventScroll: true });
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
