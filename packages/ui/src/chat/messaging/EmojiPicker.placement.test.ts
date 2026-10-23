// @vitest-environment happy-dom
/**
 * The picker flips against the chat scroller, not the window (owner, #772):
 * the trigger sits at a message's right edge inside a far wider window, so a
 * window check never flipped it and half the grid opened into the
 * scroller's clip.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import EmojiPicker from "./EmojiPicker.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) } as DOMRect;
}

describe("EmojiPicker placement", () => {
  it("aligns right when it would run past the scroller's edge, inside a wider window", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1600);
    host = document.createElement("div");
    host.setAttribute("data-testid", "conversation-thread");
    document.body.appendChild(host);
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === host) return rect(0, 0, 600, 800);
      if (this.classList.contains("emoji-picker") || this.getAttribute("role") === "menu") {
        return rect(400, 300, 640, 500);
      }
      return original.call(this);
    });
    component = mount(EmojiPicker, { target: host, props: { onpick: () => {}, onclose: () => {} } });
    await tick();
    const picker = host.querySelector(".align-right, [role='menu'], .emoji-picker");
    expect(picker?.classList.contains("align-right")).toBe(true);
  });
});
