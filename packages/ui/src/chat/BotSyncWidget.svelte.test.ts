// @vitest-environment happy-dom

// The sync strip: one line drawn from plain facts about a bot's file sync.

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
const amount = () => host!.querySelector('[data-testid="bot-sync-amount"]');
const glyph = () => host!.querySelector<SVGElement>('[data-testid="bot-sync-icon"] svg');

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
    expect(el.textContent).toContain("You can chat now. Crassly will know more as this finishes.");
    expect(el.closest(".bot-sync-slot")?.getAttribute("data-open")).toBe("true");
    // The glyph turns while the sync runs.
    expect(glyph()!.classList.contains("bot-sync-spin")).toBe(true);
  });

  it("announces the words politely, and the bar is a real progress bar", () => {
    render(syncing({ filesDone: 128, filesTotal: 412, phase: "pull" }));
    const words = widget()!.querySelector<HTMLElement>('[role="status"]')!;
    expect(words.getAttribute("aria-live")).toBe("polite");
    expect(words.textContent).toContain("Syncing your company's files");
    expect(words.textContent).toContain("Pulling files down.");
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
    expect(progress.querySelector<HTMLElement>(".bot-sync-fill")!.style.width).toBe("31%");
    // The glyph is decoration a screen reader skips.
    expect(host!.querySelector('[data-testid="bot-sync-icon"]')?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puts the words first and the percent after them, on the one line", () => {
    render(syncing({ filesDone: 128, filesTotal: 412 }));
    const el = widget()!;
    const order = Array.from(el.children).map((child) => child.getAttribute("data-testid") ?? child.getAttribute("role"));
    expect(order).toEqual(["bot-sync-icon", "status", "bot-sync-amount", "bot-sync-progress"]);
  });

  it("shows no percent in words while the bar is an estimate", () => {
    render(syncing());
    expect(amount()).toBeNull();
    expect(widget()!.textContent).not.toMatch(/\d/);
    const now = Number(bar()!.getAttribute("aria-valuenow"));
    expect(now).toBeGreaterThan(0);
    expect(now).toBeLessThan(100);
    expect(bar()!.getAttribute("aria-valuetext")).toBeNull();
  });

  it("leaves aria-valuenow out when there is no honest number", () => {
    render(syncing({ startedAt: null }));
    const progress = bar()!;
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(progress.classList.contains("is-unknown")).toBe(true);
    expect(widget()!.textContent).not.toMatch(/\d/);
    expect(amount()).toBeNull();
  });

  it("a stale sync: the neutral title, a shimmering line, no number, and a glyph that holds still", () => {
    render({ state: "stale", startedAt: NOW - 40 * 60_000, endedAt: null, filesDone: 412, filesTotal: 412 });
    const el = widget()!;
    expect(el.dataset.state).toBe("stale");
    expect(title()).toBe("Still syncing your company's files");
    expect(el.textContent).toContain("You can chat now. Crassly will know more as this finishes.");
    expect(el.textContent).not.toMatch(/\d/);
    expect(amount()).toBeNull();
    const progress = bar()!;
    expect(progress.classList.contains("is-unknown")).toBe(true);
    expect(progress.hasAttribute("aria-valuenow")).toBe(false);
    expect(glyph()!.classList.contains("bot-sync-spin")).toBe(false);
  });

  it("moves an estimated bar forward as time passes", async () => {
    render(syncing({ startedAt: NOW }));
    const before = Number(bar()!.getAttribute("aria-valuenow"));
    await vi.advanceTimersByTimeAsync(120_000);
    flushSync();
    const after = Number(bar()!.getAttribute("aria-valuenow"));
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(100);
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
    expect(title()).toBe("Sync hit a problem");
    expect(widget()!.textContent).toContain("Crassly could not finish syncing your company's files.");
    expect(widget()!.textContent).not.toMatch(/\d/);
    expect(bar()).toBeNull();
    expect(amount()).toBeNull();
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
