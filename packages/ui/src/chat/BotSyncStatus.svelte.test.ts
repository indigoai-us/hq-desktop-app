// @vitest-environment happy-dom

// The sync status in the conversation header: a still glyph and one short
// line, drawn from plain facts about a bot's file sync. It replaced the sync
// strip and its progress bar (owner, 2026-10-04); each test that pinned the
// strip's layout has its counterpart here for the header line.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import BotSyncStatus from "./BotSyncStatus.svelte";
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

function render(facts: BotSyncFacts | null): { props: { facts: BotSyncFacts | null } } {
  host = document.createElement("div");
  document.body.appendChild(host);
  const props = $state({ facts });
  component = mount(BotSyncStatus, { target: host, props });
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

const status = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-status"]');
const text = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-status-text"]');
const icon = () => host!.querySelector<HTMLElement>('[data-testid="bot-sync-status-icon"]');
const glyph = () => icon()!.querySelector<SVGElement>("svg");

const SOURCE = readFileSync(join(import.meta.dirname, "BotSyncStatus.svelte"), "utf8");
const STYLE = SOURCE.slice(SOURCE.indexOf("<style>"));
/** The declarations of one top-level rule in the component's stylesheet. */
function rule(selector: string): string {
  const at = STYLE.indexOf(`\n  ${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const open = STYLE.indexOf("{", at);
  return STYLE.slice(open + 1, STYLE.indexOf("\n  }", open));
}

/** The glyph holds still: no class or style on the icon or its svg drives a motion.
 *  The svg is the shared Phosphor rail icon, whose only class is the static
 *  `rail-icon` (no animation, transform, or transition). */
function expectStillGlyph(): void {
  const svg = glyph()!;
  expect(svg.getAttribute("data-rail-icon")).toBeTruthy();
  expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
  for (const el of [icon()!, svg]) {
    for (const name of Array.from(el.classList).filter((name) => !name.startsWith("svelte-"))) {
      expect(["bot-sync-status-icon", "rail-icon"]).toContain(name);
    }
    expect(el.getAttribute("style") ?? "").not.toMatch(/animation|transform|rotate|transition/);
  }
  expect(svg.querySelector("animate, animateTransform, animateMotion")).toBeNull();
}

describe("BotSyncStatus", () => {
  it("is not there without facts", () => {
    render(null);
    expect(status()).toBeNull();
    expect(host!.textContent?.trim()).toBe("");
  });

  it("the live run: a sync glyph and 'Syncing your company's files, 10 files so far', with the whole status in the title", () => {
    render(syncing({ filesDone: 10, filesTotal: 10, phase: "pull" }));
    const el = status()!;
    expect(el.dataset.state).toBe("syncing");
    expect(text()!.textContent).toBe("Syncing your company's files, 10 files so far");
    expect(el.getAttribute("title")).toBe("Syncing your company's files. Preparing. 10 files so far");
    // One icon, then the words: nothing else is drawn.
    expect(Array.from(el.children).map((child) => child.getAttribute("data-testid"))).toEqual([
      "bot-sync-status-icon",
      "bot-sync-status-text",
    ]);
    expect(el.textContent).not.toMatch(/\d+%|99/);
    expectStillGlyph();
  });

  it("shows the percent when there is a real one", () => {
    render(syncing({ filesDone: 128, filesTotal: 412, phase: "pull" }));
    expect(text()!.textContent).toBe("Syncing your company's files, 31%");
    expect(status()!.getAttribute("title")).toBe("Syncing your company's files. Pulling files down. 128 of 412 files (31%)");
    expectStillGlyph();
  });

  it("before any counts it is the title alone, with no number", () => {
    render(syncing());
    expect(text()!.textContent).toBe("Syncing your company's files");
    expect(status()!.textContent).not.toMatch(/\d/);
    expect(status()!.getAttribute("title")).toBe("Syncing your company's files. Preparing.");
  });

  it("has no progress bar and no strip: the old strip's parts are gone", () => {
    render(syncing({ filesDone: 128, filesTotal: 412 }));
    expect(host!.querySelector('[role="progressbar"]')).toBeNull();
    for (const old of ["bot-sync-widget", "bot-sync-progress", "bot-sync-fill", "bot-sync-amount", "bot-sync-detail", "bot-sync-title"]) {
      expect(host!.querySelector(`[data-testid="${old}"]`), old).toBeNull();
    }
    expect(SOURCE).not.toMatch(/bot-sync-track|bot-sync-fill|bot-sync-slot|bot-sync-clip|progressbar|--fill/);
    // An inline element of the header, not a block of its own.
    expect(status()!.tagName).toBe("SPAN");
  });

  it("announces the words politely, hides the glyph from a screen reader, and names the group", () => {
    render(syncing({ filesDone: 128, filesTotal: 412, phase: "pull" }));
    expect(status()!.getAttribute("role")).toBe("group");
    expect(status()!.getAttribute("aria-label")).toBe("File sync");
    expect(text()!.getAttribute("role")).toBe("status");
    expect(text()!.getAttribute("aria-live")).toBe("polite");
    expect(icon()!.getAttribute("aria-hidden")).toBe("true");
    expect(text()!.contains(icon())).toBe(false);
  });

  it("never names the bot and never says what the person can do meanwhile", () => {
    render(syncing({ filesDone: 10, filesTotal: 412 }));
    expect(status()!.textContent).not.toMatch(/Nova|Crassly|know more|chat now/);
    expect(status()!.getAttribute("title")).not.toMatch(/Nova|Crassly|know more|chat now/);
  });

  it("a stale sync: 'Still syncing.', no number, and a glyph that holds still", () => {
    render({ state: "stale", startedAt: NOW - 40 * 60_000, endedAt: null, filesDone: 412, filesTotal: 412 });
    expect(status()!.dataset.state).toBe("stale");
    expect(text()!.textContent).toBe("Still syncing.");
    expect(status()!.textContent).not.toMatch(/\d/);
    expect(status()!.getAttribute("title")).toBe("Still syncing.");
    expectStillGlyph();
  });

  it("the stylesheet has no motion at all: no animation, no keyframes, no transition, no spin", () => {
    expect(SOURCE).not.toMatch(/@keyframes/);
    expect(SOURCE).not.toMatch(/\banimation\s*:/);
    expect(SOURCE).not.toMatch(/\btransition\s*:/);
    expect(SOURCE).not.toMatch(/rotate\(|translateX|scaleX|bot-sync-spin|is-unknown/);
    expect(SOURCE).not.toMatch(/backdrop-filter/);
    expect(SOURCE).not.toMatch(/setInterval/);
  });

  it("is set in the header's muted ink at the label's size, in every state", () => {
    const root = rule(".bot-sync-status");
    // The same ink, size, weight and line height as the "Direct message" label (.channel-sub).
    expect(root).toMatch(/color:\s*var\(--t3\)/);
    expect(root).toMatch(/font-size:\s*12px/);
    expect(root).toMatch(/font-weight:\s*400/);
    expect(root).toMatch(/line-height:\s*1\.45/);
    // No state changes the ink: no accent, no green, no amber, no tinted ground.
    expect(STYLE).not.toMatch(/data-state/);
    expect(STYLE).not.toMatch(/--accent|--vio-ink|--ok-ink|--warn-ink|background/);
  });

  it("stays on one line and is cut with an ellipsis: it is the header item that gives way", () => {
    const root = rule(".bot-sync-status");
    // It takes the room that is left and may shrink to nothing, so it never
    // pushes the name, the label or "Edit profile".
    expect(root).toMatch(/flex:\s*1 1 0\b/);
    expect(root).toMatch(/min-width:\s*0/);
    expect(root).toMatch(/overflow:\s*hidden/);
    expect(root).toMatch(/white-space:\s*nowrap/);
    const words = rule(".bot-sync-status-text");
    expect(words).toMatch(/min-width:\s*0/);
    expect(words).toMatch(/overflow:\s*hidden/);
    expect(words).toMatch(/white-space:\s*nowrap/);
    expect(words).toMatch(/text-overflow:\s*ellipsis/);
    // The glyph is never squeezed.
    expect(rule(".bot-sync-status-icon")).toMatch(/flex:\s*0 0 auto/);
    // Nothing gives it a height or a wrap of its own.
    expect(STYLE).not.toMatch(/flex-wrap|min-height|(?<![-\w])height\s*:/);
  });

  it("does not change with time while syncing; it changes only when new counts arrive", async () => {
    const { props } = render(syncing({ startedAt: NOW }));
    expect(text()!.textContent).toBe("Syncing your company's files");
    await vi.advanceTimersByTimeAsync(120_000);
    flushSync();
    expect(text()!.textContent).toBe("Syncing your company's files");
    props.facts = syncing({ startedAt: NOW, filesDone: 100, filesTotal: 400 });
    await settle();
    expect(text()!.textContent).toBe("Syncing your company's files, 25%");
  });

  it("appears when a sync starts in an open conversation", async () => {
    const { props } = render(null);
    expect(status()).toBeNull();
    props.facts = syncing();
    await settle();
    expect(status()).not.toBeNull();
    expect(text()!.textContent).toBe("Syncing your company's files");
  });

  it("says up to date with a check, then goes away, exactly when the strip did", async () => {
    const { props } = render(syncing({ filesDone: 400, filesTotal: 412 }));
    props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
    await settle();
    expect(status()!.dataset.state).toBe("done");
    expect(text()!.textContent).toBe("Files are up to date.");
    expect(status()!.getAttribute("title")).toBe("Files are up to date. 412 files synced.");
    expectStillGlyph();
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS - 1_500);
    flushSync();
    expect(status()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_600);
    flushSync();
    // Gone at the moment the model says, with nothing left behind.
    expect(status()).toBeNull();
    expect(host!.textContent?.trim()).toBe("");
  });

  it("shows up to date after a long sync that needed no clock", async () => {
    const { props } = render(syncing({ filesDone: 10, filesTotal: 412 }));
    await vi.advanceTimersByTimeAsync(600_000);
    props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
    await settle();
    expect(status()!.dataset.state).toBe("done");
    await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS + 100);
    flushSync();
    expect(status()).toBeNull();
  });

  it("says a failed sync in one sentence, with no number, and stays", async () => {
    render({ state: "failed", startedAt: NOW - 60_000, endedAt: NOW, filesDone: 3, filesTotal: 412 });
    expect(status()!.dataset.state).toBe("failed");
    expect(text()!.textContent).toBe("Sync hit a problem.");
    expect(status()!.textContent).not.toMatch(/\d/);
    expectStillGlyph();
    await vi.advanceTimersByTimeAsync(3_600_000);
    flushSync();
    expect(status()).not.toBeNull();
  });

  it("runs no ticking clock: one timer to the moment 'up to date' goes away, and none while syncing", async () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    try {
      const { props } = render(syncing({ filesDone: 10, filesTotal: 412 }));
      await settle();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(interval).not.toHaveBeenCalled();
      expect(timeout).not.toHaveBeenCalled();
      props.facts = { state: "done", startedAt: NOW - 60_000, endedAt: Date.now(), filesDone: 412, filesTotal: 412 };
      await settle();
      expect(interval).not.toHaveBeenCalled();
      // The one timer is set to the hide deadline, not to a one second tick.
      const waits = timeout.mock.calls.map(([, ms]) => ms);
      expect(waits).toEqual([BOT_SYNC_DONE_VISIBLE_MS]);
      await vi.advanceTimersByTimeAsync(BOT_SYNC_DONE_VISIBLE_MS + 100);
      flushSync();
      expect(status()).toBeNull();
      expect(interval).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
      timeout.mockRestore();
    }
  });

  it("goes away when the facts are taken away", async () => {
    const { props } = render(syncing());
    props.facts = null;
    await settle();
    expect(status()).toBeNull();
  });
});
