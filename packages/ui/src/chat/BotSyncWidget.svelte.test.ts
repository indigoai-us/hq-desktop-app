// @vitest-environment happy-dom

// The sync widget: a slim bar drawn from plain facts about a bot's file sync.

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

describe("BotSyncWidget", () => {
  it("is not there without facts", () => {
    render(null);
    expect(widget()).toBeNull();
    expect(host!.textContent?.trim()).toBe("");
  });

  it("shows a syncing bar with the title, the line and a progress bar", () => {
    render(syncing());
    const el = widget()!;
    expect(el.dataset.state).toBe("syncing");
    expect(title()).toBe("Syncing your company's files");
    expect(el.textContent).toContain("You can chat now. Crassly will know more as this finishes.");
    expect(el.closest(".bot-sync-slot")?.getAttribute("data-open")).toBe("true");
  });

  it("announces the words politely, and the bar is a real progress bar", () => {
    render(syncing({ filesDone: 128, filesTotal: 412 }));
    const words = widget()!.querySelector<HTMLElement>('[role="status"]')!;
    expect(words.getAttribute("aria-live")).toBe("polite");
    expect(words.textContent).toContain("Syncing your company's files");
    expect(widget()!.getAttribute("aria-label")).toBe("File sync");
    const progress = bar()!;
    expect(progress.getAttribute("role")).toBe("progressbar");
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.getAttribute("aria-valuenow")).toBe("31");
    expect(progress.getAttribute("aria-valuetext")).toBe("128 of 412 files");
    expect(progress.getAttribute("aria-label")).toBe("Syncing your company's files");
    // The moving bar is not inside the announced words.
    expect(words.contains(progress)).toBe(false);
    expect(host!.querySelector('[data-testid="bot-sync-amount"]')?.textContent).toBe("31%");
    expect(progress.querySelector<HTMLElement>(".bot-sync-fill")!.style.width).toBe("31%");
    // The art is a layer a screen reader skips.
    expect(widget()!.querySelector(".bot-sync-art")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows no percent in words while the bar is an estimate", () => {
    render(syncing());
    expect(host!.querySelector('[data-testid="bot-sync-amount"]')).toBeNull();
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
    expect(host!.querySelector('[data-testid="bot-sync-amount"]')).toBeNull();
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

  it("shows up to date with a full bar, then goes away", async () => {
    const { props } = render(syncing({ filesDone: 400, filesTotal: 412 }));
    props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
    await settle();
    expect(widget()!.dataset.state).toBe("done");
    expect(title()).toBe("Files are up to date.");
    expect(bar()!.getAttribute("aria-valuenow")).toBe("100");
    expect(host!.querySelector('[data-testid="bot-sync-amount"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS - 1_500);
    flushSync();
    expect(widget()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    flushSync();
    // Closing: the height goes first, then the bar leaves the page.
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

  it("says a failed sync in one sentence, with no bar, and stays", async () => {
    render({ state: "failed", startedAt: NOW - 60_000, endedAt: NOW, filesDone: 3, filesTotal: 412 });
    expect(widget()!.dataset.state).toBe("failed");
    expect(title()).toBe("File sync did not finish");
    expect(widget()!.textContent).toContain("Crassly could not finish downloading your company's files.");
    expect(bar()).toBeNull();
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
