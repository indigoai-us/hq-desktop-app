// @vitest-environment happy-dom

/**
 * What sits outside the scroll flow: the host's strip across the top (a
 * bot's file sync), and under the thread the message box. Neither scrolls
 * with the messages. A bot's suggested replies are not pinned: they are part
 * of the bot's newest message, in the thread. When the strip or the pinned
 * area grows or shrinks the scroller changes height: a reader at the newest
 * message stays there, and a reader who scrolled up is not moved.
 *
 * happy-dom does no layout, so the scroller's box is stubbed, and a stand-in
 * ResizeObserver lets the test say "the scroller changed height".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRawSnippet, flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

/** Every callback given to a ResizeObserver while the test runs. */
let resizeCallbacks: Array<() => void> = [];
const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  resizeCallbacks = [];
  class FakeResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      resizeCallbacks.push(callback);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      resizeCallbacks = resizeCallbacks.filter((entry) => entry !== this.callback);
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  globalThis.ResizeObserver = realResizeObserver;
});

/** The bot's suggested replies, written into its last message. */
const SUGGESTIONS = '\n```hq-block\n{"v":1,"blocks":[{"kind":"suggestions","items":["Yes","Not yet"]}]}\n```';

function messages(count: number): ConversationMessageWire[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt_${i + 1}`,
    direction: "in",
    fromPersonUid: "agt_nova",
    fromDisplayName: "Nova",
    body: `message ${i + 1}${i === count - 1 ? SUGGESTIONS : ""}`,
    createdAt: new Date(Date.UTC(2026, 9, 2, 14, i)).toISOString(),
  })) as ConversationMessageWire[];
}

const probe = createRawSnippet(() => ({ render: () => '<div data-testid="strip-probe">Syncing</div>' }));
const thinking = createRawSnippet(() => ({ render: () => '<div data-testid="thinking-probe">Nova is thinking</div>' }));
const intro = createRawSnippet(() => ({ render: () => '<div data-testid="header-probe">About Nova</div>' }));

async function mountConversation(props: Record<string, unknown>): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, { target: host, props: { messages: messages(30), ...props } as never });
  flushSync();
  await tick();
}

const thread = (): HTMLElement => host.querySelector<HTMLElement>('[data-testid="conversation-thread"]')!;
const before = (a: Element, b: Element): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** A scroller with a real-looking box: 3000px of messages in a window of `box.viewport`. */
function stubLayout(box: { viewport: number }): HTMLElement {
  const el = thread();
  Object.defineProperty(el, "clientHeight", { get: () => box.viewport, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 3000, configurable: true });
  return el;
}

async function scrollTo(el: HTMLElement, top: number): Promise<void> {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
  // The scroll handler reads the position once per frame.
  await new Promise((resolve) => setTimeout(resolve, 40));
  await tick();
}

function resized(): void {
  for (const callback of [...resizeCallbacks]) callback();
}

describe("ChannelConversation strip and pinned area", () => {
  it("draws the host's strip above the thread, then the thread with the bot's suggested replies in it, then the message box", async () => {
    await mountConversation({ aboveMessages: probe, belowMessages: thinking, header: intro, suggestionsFrom: "agt_nova" });
    const strip = host.querySelector<HTMLElement>('[data-testid="strip-probe"]')!;
    expect(strip).not.toBeNull();
    // Not in the scroller: it stays in view while the person scrolls.
    expect(thread().contains(strip)).toBe(false);
    expect(strip.closest('[data-testid="conversation-strip"]')).not.toBeNull();
    // Above the scroller and everything in it, including the thread's own intro.
    expect(before(strip, thread())).toBe(true);
    const headerProbe = host.querySelector<HTMLElement>('[data-testid="header-probe"]')!;
    expect(thread().contains(headerProbe)).toBe(true);
    expect(before(strip, headerProbe)).toBe(true);
    // The status row (a bot thinking) is still the last row of the thread itself.
    const lastRow = host.querySelector<HTMLElement>('[data-testid="thinking-probe"]')!;
    expect(thread().contains(lastRow)).toBe(true);
    // The suggested replies are part of the bot's newest message: in the
    // thread, under that message, before the thinking row and the message box.
    const chips = host.querySelector<HTMLElement>('[data-testid="suggested-replies"]')!;
    const box = host.querySelector<HTMLElement>('[data-testid="conversation-composer"]')!;
    expect(thread().contains(chips)).toBe(true);
    expect(chips.closest('[data-testid="conversation-message"]')?.getAttribute("data-event-id")).toBe("evt_30");
    expect(before(chips, lastRow)).toBe(true);
    expect(before(thread(), box)).toBe(true);
    expect(host.querySelectorAll('[data-testid="suggested-replies"]')).toHaveLength(1);
    // The strip is the first thing in the pane, before the scroller's column.
    const pane = host.querySelector<HTMLElement>('[data-testid="conversation-view"]')!;
    const stripSlot = host.querySelector<HTMLElement>('[data-testid="conversation-strip"]')!;
    expect(stripSlot.parentElement).toBe(pane);
    expect(before(stripSlot, pane.querySelector(".conversation-body")!)).toBe(true);
  });

  it("has no strip when the host gives none, or in a header-only pane", async () => {
    await mountConversation({});
    expect(host.querySelector('[data-testid="conversation-strip"]')).toBeNull();
    await unmount(component!);
    component = null;
    host.remove();
    await mountConversation({ aboveMessages: probe, headerOnly: true });
    expect(host.querySelector('[data-testid="strip-probe"]')).toBeNull();
    expect(host.querySelector('[data-testid="conversation-strip"]')).toBeNull();
  });

  it("keeps a reader at the newest message there when the strip takes room", async () => {
    await mountConversation({ aboveMessages: probe });
    const box = { viewport: 600 };
    const el = stubLayout(box);
    await scrollTo(el, 2400);
    resized();
    // The sync strip appears: the scroller loses 32px. Without a pin the
    // newest message would sit 32px under the fold.
    box.viewport = 568;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
    // The strip goes: the scroller is tall again and still at the bottom.
    box.viewport = 600;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
  });

  it("leaves a reader who scrolled up where they are", async () => {
    await mountConversation({ aboveMessages: probe });
    const box = { viewport: 600 };
    const el = stubLayout(box);
    await scrollTo(el, 2400);
    resized();
    await scrollTo(el, 900);
    box.viewport = 568;
    resized();
    expect(el.scrollTop).toBe(900);
    box.viewport = 600;
    resized();
    expect(el.scrollTop).toBe(900);
  });
});
