// @vitest-environment happy-dom

// The sync strip: one line drawn from plain facts about a bot's file sync.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import BotSyncWidget from "./BotSyncWidget.svelte";
import { BOT_SYNC_DONE_VISIBLE_MS, type BotSyncFacts } from "./bot-sync-model.js";

const NOW = Date.parse("2026-10-02T15:00:00.000Z");

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function syncing(over: Partial<BotSyncFacts> = {}): BotSyncFacts {
  return { state: "syncing", startedAt: NOW - 60_000, endedAt: null, filesDone: null, filesTotal: null, ...over };
}

function render(facts: BotSyncFacts | null): { props: { facts: BotSyncFacts | null; botName: string } } {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = $state({ facts, botName: "Crassly" });
  component = mount(BotSyncWidget, { target: host, props });
  flushSync();
  return { props };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

const widget = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-widget"]');
const bar = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-progress"]');
const title = () => host!.querySelector('[data-testid="bot-sync-title"]')?.textContent ?? "";
const detail = () => host!.querySelector('[data-testid="bot-sync-detail"]')?.textContent ?? "";
const amount = () => host!.querySelector('[data-testid="bot-sync-amount"]');
const glyph = () => host!.querySelector<SVGElement>('[data-testid="bot-sync-icon"] svg');
const fill = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-fill"]');
const fillWidth = () => parseFloat(fill()!.style.width);

const SOURCE = readFileSync(join(import.meta.dirname, "BotSyncWidget.svelte"), "utf8");
/** The declarations of one top-level rule in the component's stylesheet. */
function rule(selector: string): string {
  const style = SOURCE.slice(SOURCE.indexOf("<style>"));
  const at = style.indexOf(`\n  ${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const open = style.indexOf("{", at);
  return style.slice(open + 1, style.indexOf("\n  }", open));
}

/** The glyph holds still: no class or style on the icon or its svg drives a motion. */
function expectStillGlyph(): void {
  const icon = host!.querySelector<HTMLElement>('[data-testid="bot-sync-icon"]')!;
  const svg = glyph()!;
  for (const el of [icon, svg]) {
    for (const name of Array.from(el.classList).filter((name) => !name.startsWith("svelte-"))) {
      expect(["bot-sync-icon", "bot-sync-glyph"]).toContain(name);
    }
    expect(el.getAttribute("style") ?? "").not.toMatch(/animation|transform|rotate/);
  }
}

/** The bar is never an animated sweep: no class or style on the track or fill drives a motion. */
function expectStillBar(): void {
  const track = bar()!;
  for (const el of [track, fill()!]) {
    // Svelte's own scoping class aside, the bar carries only its base class.
    for (const name of Array.from(el.classList).filter((name) => !name.startsWith("svelte-"))) {
      expect(["bot-sync-track", "bot-sync-fill"]).toContain(name);
    }
    expect(el.getAttribute("style") ?? "").not.toMatch(/animation|transform/);
  }
  expect(track.classList.contains("is-unknown")).toBe(false);
}

describe("BotSyncWidget", () => {
  it("is not there without facts", () => {
    render(null);
    expect(widget()).toBeNull();
    expect(host!.textContent?.trim()).toBe("");
  });

  it("shows a syncing strip with the title, the line and a progress bar", () => {
    render(syncing());
    const el = widget()!;
    expect(el.dataset.state).toBe("syncing");
    expect(title()).toBe("Syncing your company's files");
    expect(detail()).toBe("Preparing.");
    expect(el.textContent).not.toContain("Crassly");
    expect(el.closest(".bot-sync-slot")?.getAttribute("data-open")).toBe("true");
    // The glyph holds still even while the sync runs.
    expectStillGlyph();
  });

  it("the live run: 10 of 10 planned and not finished reads 'Preparing.' with the files so far, no percent, an empty still bar", () => {
    render(syncing({ filesDone: 10, filesTotal: 10, phase: "pull" }));
    const el = widget()!;
    expect(el.dataset.state).toBe("syncing");
    expect(title()).toBe("Syncing your company's files");
    expect(detail()).toBe("Preparing. 10 files so far");
    expect(amount()).toBeNull();
    expect(el.textContent).not.toMatch(/\d+%/);
    expect(el.textContent).not.toContain("99");
    const progress = bar()!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(progress.getAttribute("aria-valuetext")).toBe("10 files so far");
    expect(fillWidth()).toBe(0);
    expectStillBar();
    expectStillGlyph();
  });

  it("the live box: 10 of 68,322 is a nearly empty determinate bar and the counts in words", () => {
    render(syncing({ filesDone: 10, filesTotal: 68_322, phase: "pull" }));
    expect(detail()).toBe("Pulling files down. 10 of 68,322 files");
    expect(amount()?.textContent).toBe("<1%");
    expect(bar()!.getAttribute("aria-valuenow")).toBe("0");
    expect(bar()!.getAttribute("aria-valuetext")).toBe("10 of 68,322 files");
    const width = fillWidth();
    expect(width).toBeCloseTo((10 / 68_322) * 100, 6);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThan(1);
    expectStillBar();
  });

  it("the stylesheet has no animation at all: no sweeping bar and no spinning glyph", () => {
    expect(SOURCE).not.toMatch(/is-unknown|bot-sync-travel|translateX|bot-sync-spin/);
    expect(SOURCE).not.toMatch(/@keyframes/);
    expect(SOURCE).not.toMatch(/\banimation\s*:/);
    expect(SOURCE).not.toMatch(/rotate\(/);
  });

  it("draws the bar in the theme's muted grey ink over a fainter track, never the accent or a hard-coded white", () => {
    const strip = rule(".bot-sync");
    expect(strip).toMatch(/--bs-bar:\s*var\(--t3\b/);
    expect(strip).toMatch(/--bs-bar-track:\s*var\(--line\b/);
    expect(rule(".bot-sync-fill")).toMatch(/background:\s*var\(--bs-bar\)/);
    expect(rule(".bot-sync-track")).toMatch(/background:\s*var\(--bs-bar-track\)/);
    for (const block of [rule(".bot-sync-fill"), rule(".bot-sync-track")]) {
      expect(block).not.toMatch(/--bs-tone|--bs-accent|--accent|#fff|white/i);
    }
  });

  it("left-aligns the words from the strip's edge, not the centred message column", () => {
    const strip = rule(".bot-sync");
    expect(strip).toMatch(/text-align:\s*left/);
    expect(strip).toMatch(/justify-content:\s*flex-start/);
    expect(strip).not.toMatch(/--conv-inset/);
    expect(rule(".bot-sync-words")).toMatch(/justify-content:\s*flex-start/);
    expect(SOURCE).not.toMatch(/text-align:\s*center|justify-content:\s*center/);
    // The percent still sits at the right.
    expect(rule(".bot-sync-amount")).toMatch(/text-align:\s*right/);
  });

  it("announces the words politely, and the bar is a real progress bar", () => {
    render(syncing({ filesDone: 128, filesTotal: 412, phase: "pull" }));
    const words = widget()!.querySelector<HTMLElement>('[role="status"]')!;
    expect(words.getAttribute("aria-live")).toBe("polite");
    expect(words.textContent).toContain("Syncing your company's files");
    expect(detail()).toBe("Pulling files down. 128 of 412 files");
    expect(widget()!.getAttribute("aria-label")).toBe("File sync");
    const progress = bar()!;
    expect(progress.getAttribute("role")).toBe("progressbar");
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.getAttribute("aria-valuenow")).toBe("31");
    expect(progress.getAttribute("aria-valuetext")).toBe("128 of 412 files");
    expect(progress.getAttribute("aria-label")).toBe("Syncing your company's files");
    // The moving bar is not inside the announced words, and neither is the percent.
    expect(words.contains(progress)).toBe(false);
    expect(words.contains(amount()!)).toBe(false);
    expect(amount()?.textContent).toBe("31%");
    expect(fillWidth()).toBeCloseTo((128 / 412) * 100, 6);
    expectStillBar();
    // The glyph is decoration a screen reader skips.
    expect(host!.querySelector('[data-testid="bot-sync-icon"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the words first and the percent after them, on the one line", () => {
    render(syncing({ filesDone: 128, filesTotal: 412 }));
    const el = widget()!;
    const order = Array.from(el.children).map((child) => child.getAttribute("data-testid") ?? child.getAttribute("role"));
    expect(order).toEqual(["bot-sync-icon", "status", "bot-sync-amount", "bot-sync-progress"]);
  });

  it("before any counts: 'Preparing.', no percent, and the empty track with no fill", () => {
    render(syncing());
    expect(detail()).toBe("Preparing.");
    expect(amount()).toBeNull();
    expect(widget()!.textContent).not.toMatch(/\d/);
    expect(bar()!.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar()!.getAttribute("aria-valuetext")).toBeNull();
    expect(fillWidth()).toBe(0);
    expectStillBar();
  });

  it("leaves aria-valuenow out when there is no honest number", () => {
    render(syncing({ startedAt: null }));
    const progress = bar()!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(fillWidth()).toBe(0);
    expectStillBar();
    expect(widget()!.textContent).not.toMatch(/\d/);
    expect(amount()).toBeNull();
  });

  it("a stale sync: 'Still syncing.', an empty still bar, no number, and a glyph that holds still", () => {
    render({ state: "stale", startedAt: NOW - 40 * 60_000, endedAt: null, filesDone: 412, filesTotal: 412 });
    const el = widget()!;
    expect(el.dataset.state).toBe("stale");
    expect(title()).toBe("Still syncing.");
    expect(host!.querySelector('[data-testid="bot-sync-detail"]')).toBeNull();
    expect(el.textContent).not.toMatch(/\d/);
    expect(amount()).toBeNull();
    const progress = bar()!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(fillWidth()).toBe(0);
    expectStillBar();
    expectStillGlyph();
  });

  it("does not move the bar with time; it moves only when new counts arrive", async () => {
    const { props } = render(syncing({ startedAt: NOW }));
    expect(fillWidth()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    flushSync();
    expect(fillWidth()).toBe(0);
    expect(bar()!.hasAttribute("aria-valuenow")).toBe(false);
    props.facts = syncing({ startedAt: NOW, filesDone: 100, filesTotal: 400 });
    await settle();
    expect(fillWidth()).toBe(25);
    expect(bar()!.getAttribute("aria-valuenow")).toBe("25");
    expectStillBar();
  });

  it("appears when a sync starts in an open conversation", async () => {
    const { props } = render(null);
    expect(widget()).toBeNull();
    props.facts = syncing();
    await settle();
    expect(widget()).not.toBeNull();
    expect(widget()!.closest(".bot-sync-slot")?.getAttribute("data-open")).toBe("true");
  });

  it("shows up to date with a full bar, then fades away", async () => {
    const { props } = render(syncing({ filesDone: 400, filesTotal: 412 }));
    props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
    await settle();
    expect(widget()!.dataset.state).toBe("done");
    expect(title()).toBe("Files are up to date.");
    expect(bar()!.getAttribute("aria-valuenow")).toBe("100");
    expect(fillWidth()).toBe(100);
    expectStillBar();
    expectStillGlyph();
    expect(amount()).toBeNull();
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS - 1_500);
    flushSync();
    expect(widget()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    flushSync();
    // Closing: it fades and its height goes first, then it leaves the page.
    expect(host!.querySelector(".bot-sync-slot")?.getAttribute("data-open") ?? "false").toBe("false");
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    expect(widget()).toBeNull();
  });

  it("shows up to date after a long sync whose bar needed no clock", async () => {
    const { props } = render(syncing({ filesDone: 10, filesTotal: 412 }));
    // Real counts: nothing ticks. Ten minutes pass.
    await vi.advanceTimersByTimeAsync(600_000);
    props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
    await settle();
    expect(widget()!.dataset.state).toBe("done");
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS + 1_500);
    flushSync();
    expect(widget()).toBeNull();
  });

  it("says a failed sync in one sentence, with no bar and no percent, and stays", async () => {
    render({ state: "failed", startedAt: NOW - 60_000, endedAt: NOW, filesDone: 3, filesTotal: 412 });
    expect(widget()!.dataset.state).toBe("failed");
    expect(title()).toBe("Sync hit a problem.");
    expect(widget()!.textContent).not.toContain("Crassly");
    expect(widget()!.textContent).not.toMatch(/\d/);
    expect(bar()).toBeNull();
    expect(amount()).toBeNull();
    expectStillGlyph();
    await vi.advanceTimersByTimeAsync(3_600_000);
    flushSync();
    expect(widget()).not.toBeNull();
  });

  it("goes away when the facts are taken away", async () => {
    const { props } = render(syncing());
    props.facts = null;
    await settle();
    await vi.advanceTimersByTimeAsync(400);
    flushSync();
    expect(widget()).toBeNull();
  });
});
