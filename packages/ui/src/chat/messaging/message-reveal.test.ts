// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  REVEAL_LINE_STEP_MS,
  REVEAL_MAX_DURATION_MS,
  RevealTracker,
  lineUnits,
  planReveal,
  revealedPrefixLines,
  smoothFollow,
} from "./message-reveal";

describe("lineUnits", () => {
  it("treats paragraphs, list items and code blocks as one line each", () => {
    const root = document.createElement("div");
    root.innerHTML =
      "<p>First <a href='#'>link</a></p><ul><li>one</li><li>two</li></ul><pre><code>x = 1</code></pre>";
    const units = lineUnits(root);
    expect(units.map((u) => u.tagName)).toEqual(["P", "LI", "LI", "PRE"]);
    // Links and code stay inside their line, untouched.
    expect(root.querySelector("a")?.textContent).toBe("link");
  });
});

describe("planReveal", () => {
  it("staggers short replies at the natural line step", () => {
    expect(planReveal(4).stepMs).toBe(REVEAL_LINE_STEP_MS);
  });

  it("caps a long reply so the last line starts within the max duration", () => {
    const plan = planReveal(200);
    expect(plan.stepMs * 199).toBeLessThanOrEqual(REVEAL_MAX_DURATION_MS);
  });

  it("is instant under reduced motion", () => {
    expect(planReveal(50, { reducedMotion: true })).toEqual({ stepMs: 0, totalMs: 0 });
  });
});

describe("revealedPrefixLines", () => {
  it("animates only lines appended to a growing body", () => {
    // The last earlier line may still be mid-stream, so it re-settles.
    expect(revealedPrefixLines("a\n\nb", 2, "a\n\nb\n\nc\n\nd", 4)).toBe(1);
  });

  it("animates everything for a fresh body", () => {
    expect(revealedPrefixLines("", 0, "a", 1)).toBe(0);
  });

  it("does not replay a body that changed in the middle", () => {
    expect(revealedPrefixLines("a b", 1, "x b c", 2)).toBe(2);
  });
});

describe("RevealTracker", () => {
  const bot = (id: string) => ({ id, bot: true });
  const human = (id: string) => ({ id, bot: false });

  it("never reveals history, then reveals new bot replies at the tail", () => {
    const t = new RevealTracker();
    expect([...t.observe("c1", [bot("a"), human("b")])]).toEqual([]);
    const next = t.observe("c1", [bot("a"), human("b"), human("c"), bot("d")]);
    expect([...next]).toEqual(["d"]);
  });

  it("waits for loading to finish before seeding history", () => {
    const t = new RevealTracker();
    t.observe("c1", [], true);
    expect([...t.observe("c1", [bot("a")])]).toEqual([]);
  });

  it("does not reveal earlier pages prepended above known messages", () => {
    const t = new RevealTracker();
    t.observe("c1", [bot("m")]);
    expect([...t.observe("c1", [bot("old"), bot("m")])]).toEqual([]);
  });

  it("resets when the conversation changes", () => {
    const t = new RevealTracker();
    t.observe("c1", [bot("a")]);
    t.observe("c1", [bot("a"), bot("b")]);
    expect([...t.observe("c2", [bot("x")])]).toEqual([]);
  });
});

/** A scroller with fixed geometry and a manual frame clock. */
function fakeScroller(scrollHeight: number, clientHeight: number, scrollTop: number) {
  const el = document.createElement("div");
  let top = scrollTop;
  Object.defineProperty(el, "scrollHeight", { get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    get: () => top,
    set: (v: number) => {
      top = Math.min(Math.max(0, v), scrollHeight - clientHeight);
    },
  });
  let clock = 0;
  const queue: Array<(t: number) => void> = [];
  return {
    el,
    raf: (cb: (t: number) => void) => queue.push(cb),
    caf: () => {},
    now: () => clock,
    step(ms = 16) {
      clock += ms;
      const cb = queue.shift();
      cb?.(clock);
      return Boolean(cb);
    },
  };
}

describe("smoothFollow", () => {
  it("glides a pinned reader to the bottom over several frames, never in one snap", () => {
    const s = fakeScroller(1300, 400, 600);
    let done: boolean | null = null;
    smoothFollow(s.el, { durationMs: 300, raf: s.raf, caf: s.caf, now: s.now, ondone: (a) => (done = a) });
    s.step();
    const afterFirst = s.el.scrollTop;
    expect(afterFirst).toBeGreaterThan(600);
    expect(afterFirst).toBeLessThan(900);
    for (let i = 0; i < 200 && s.step(); i++);
    expect(s.el.scrollTop).toBe(900);
    expect(done).toBe(false);
  });

  it("stops and leaves the reader alone once they scroll up", () => {
    const s = fakeScroller(1300, 400, 600);
    let done: boolean | null = null;
    smoothFollow(s.el, { durationMs: 300, raf: s.raf, caf: s.caf, now: s.now, ondone: (a) => (done = a) });
    s.step();
    s.el.scrollTop = 100; // the reader scrolls up
    s.step();
    for (let i = 0; i < 50 && s.step(); i++);
    expect(s.el.scrollTop).toBe(100);
    expect(done).toBe(true);
  });
});
