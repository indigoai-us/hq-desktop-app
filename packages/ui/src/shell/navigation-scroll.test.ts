// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureNavigationScroll,
  createNavigationScrollTracker,
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

/**
 * Regression coverage for the channel-switch lag: `navigate()` used to call
 * `rememberScroll()` -> `captureNavigationScroll(document)` synchronously
 * inside the row-click handler, which reads `scrollTop`/`offsetTop` on the
 * outgoing conversation's DOM and forces the browser to flush a pending
 * layout before it can answer. On a long transcript that forced layout is
 * exactly the lag users saw between clicking a row and anything changing on
 * screen — the click's own call stack has to finish, with that reflow
 * inside it, before the browser can paint the new selection.
 *
 * `createNavigationScrollTracker` moves the read off the click path: it
 * samples the scroller only on `scroll`/`resize`, so `navigate()` can call
 * `read()` for free. These tests fail on the old "scan on demand" shape
 * (no tracker, `read` calling into the DOM every time) and pass on the new
 * one (samples only follow a scroll/resize, `read()` never touches the
 * DOM).
 */
describe("navigation scroll tracker samples off the click path", () => {
  it("never touches the DOM when read() is called without a prior scroll", () => {
    const el = scroller("conversation-thread", "<p>hello</p>");
    const scan = vi.spyOn(el, "querySelectorAll");
    const tracker = createNavigationScrollTracker(() => document);
    try {
      // A click mid-conversation calls read() repeatedly (e.g. once per
      // navigate()); none of those calls may scan the DOM.
      tracker.read();
      tracker.read();
      tracker.read();
      expect(scan).not.toHaveBeenCalled();
    } finally {
      tracker.stop();
    }
  });

  it("samples on scroll (throttled to animation frames), and read() returns that sample without re-scanning", async () => {
    const el = scroller("conversation-thread", "<p>hello</p>");
    el.scrollTop = 77;
    const scan = vi.spyOn(el, "querySelectorAll");
    const tracker = createNavigationScrollTracker(() => document);
    try {
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(scan).toHaveBeenCalledTimes(1);

      const sample = tracker.read();
      expect(sample).toEqual({ kind: "pixel", id: null, offset: 77 });
      // Reading the last sample again must not scan the DOM a second time.
      tracker.read();
      expect(scan).toHaveBeenCalledTimes(1);
    } finally {
      tracker.stop();
    }
  });

  it("stop() removes its listeners so a later scroll cannot trigger another scan", async () => {
    const el = scroller("conversation-thread", "<p>hello</p>");
    const scan = vi.spyOn(el, "querySelectorAll");
    const tracker = createNavigationScrollTracker(() => document);
    tracker.stop();
    document.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    expect(scan).not.toHaveBeenCalled();
  });
});

/**
 * Regression coverage for the stale-destination bug: before `invalidate()`
 * existed, `read()` returned whatever the *last* scroll/resize sampled,
 * with no notion of which destination that sample belonged to. Sequence:
 * A (scrolled) -> navigate to B (no scroll/resize ever fires in B, e.g. a
 * short conversation) -> navigate to C. The old tracker still had A's
 * sample sitting in `last`, so it got attributed to B's history entry
 * instead of B's own (empty) state. Restoring B later replayed A's scroll
 * position onto B.
 *
 * `invalidate()` — called by the navigation controller right after a
 * destination commits — drops that stale sample and queues a fresh rAF
 * read of the new destination, so a subsequent `read()` either has B's own
 * sample or (if nothing rendered/scrolled yet) correctly returns null.
 */
describe("navigation scroll tracker invalidates on destination commit", () => {
  it("returns null for a destination that never scrolled, never the previous destination's sample", async () => {
    const el = scroller("conversation-thread", "<p>hello</p>");
    el.scrollTop = 800;
    const tracker = createNavigationScrollTracker(() => document);
    try {
      // Conversation A scrolls to 800; the tracker samples it.
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(tracker.read()).toEqual({ kind: "pixel", id: null, offset: 800 });

      // navigate() consumes A's sample via read(), then the controller
      // commits B and calls invalidate() — B never fires scroll/resize.
      const forA = tracker.read();
      expect(forA).toEqual({ kind: "pixel", id: null, offset: 800 });
      tracker.invalidate();

      // Leaving B (no sample was ever taken for it) must not hand back A's
      // state.
      expect(tracker.read()).toBeNull();
    } finally {
      tracker.stop();
    }
  });

  it("picks up the new destination's own sample once it scrolls, still without a synchronous scan", async () => {
    const el = scroller("conversation-thread", "<p>hello</p>");
    el.scrollTop = 800;
    const tracker = createNavigationScrollTracker(() => document);
    try {
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(tracker.read()).toEqual({ kind: "pixel", id: null, offset: 800 });

      // Commit to B: invalidate() drops A's sample and queues B's own rAF
      // sample (off the click path — no scan happens synchronously here).
      const scan = vi.spyOn(el, "querySelectorAll");
      tracker.invalidate();
      expect(scan).not.toHaveBeenCalled();

      // B renders at a different offset and the queued sample fires next
      // frame.
      el.scrollTop = 40;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      expect(tracker.read()).toEqual({ kind: "pixel", id: null, offset: 40 });
    } finally {
      tracker.stop();
    }
  });
});
