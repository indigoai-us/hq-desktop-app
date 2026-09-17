// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  captureNavigationScroll,
  restoreNavigationScroll,
  scheduleNavigationScrollRestore,
} from "./navigation-scroll.js";

function scroller(testId: string, html: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", testId);
  el.innerHTML = html;
  Object.defineProperty(el, "clientHeight", { value: 300, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("navigation scroll capture and restore", () => {
  it("prefers a visible message identity over pixel offset", () => {
    const el = scroller(
      "conversation-thread",
      `<div data-event-id="evt_a" style="height:80px"></div>
       <div data-event-id="evt_mid" style="height:80px"></div>`,
    );
    const mid = el.querySelector("[data-event-id='evt_mid']") as HTMLElement;
    Object.defineProperty(mid, "offsetTop", { value: 840, configurable: true });
    Object.defineProperty(mid, "offsetHeight", { value: 80, configurable: true });
    el.scrollTop = 840;
    expect(captureNavigationScroll(document)).toEqual({
      kind: "message",
      id: "evt_mid",
      offset: 840,
    });
  });

  it("falls back to pixel offset when no identity is present", () => {
    const el = scroller("conversation-thread", "<p>empty</p>");
    el.scrollTop = 120;
    expect(captureNavigationScroll(document)).toEqual({
      kind: "pixel",
      id: null,
      offset: 120,
    });
  });

  it("restores a file identity and retries until the node exists", async () => {
    const el = scroller("channel-files-list", "");
    const promise = new Promise<boolean>((resolve) => {
      scheduleNavigationScrollRestore(
        () => document,
        { kind: "file", id: "readme.md", offset: 0 },
        { attempts: 8, delayMs: 5, onDone: resolve },
      );
    });
    setTimeout(() => {
      const row = document.createElement("button");
      row.setAttribute("data-file-key", "readme.md");
      el.appendChild(row);
    }, 12);
    await expect(promise).resolves.toBe(true);
    expect(restoreNavigationScroll(document, { kind: "file", id: "readme.md", offset: 0 })).toBe(
      true,
    );
  });
});
