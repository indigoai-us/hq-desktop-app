// @vitest-environment happy-dom

/**
 * What sits outside the scroll flow: under the thread, the message box. It
 * does not scroll with the messages. A bot's suggested replies are not
 * pinned: they are part of the bot's newest message, in the thread. When the
 * pinned area grows or shrinks the scroller changes height: a reader at the
 * newest message stays there, and a reader who scrolled up is not moved.
 *
 * Rewritten 2026-10-04: the conversation used to take a host strip across
 * its top (a bot's file sync, with a progress bar), and these tests pinned
 * where that strip sat. The strip is gone: the sync status is one line in
 * the host's header (BotSyncStatus.svelte, and its place is pinned in
 * shell/DesktopApp.cloud-bot-sync.test.ts). What stays true here is the
 * order of the pane and that the scroller holds its place when it changes
 * height.
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

describe("ChannelConversation pinned area", () => {
  it("draws the thread with the bot's suggested replies in it, then the message box, and nothing above the thread", async () => {
    await mountConversation({ belowMessages: thinking, header: intro, suggestionsFrom: "agt_nova" });
    // The thread's own intro is in the scroller.
    const headerProbe = host.querySelector<HTMLElement>('[data-testid="header-probe"]')!;
    expect(thread().contains(headerProbe)).toBe(true);
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
    // Nothing of the host's sits across the top of the pane: the scroller's
    // column is the first thing in it.
    const pane = host.querySelector<HTMLElement>('[data-testid="conversation-view"]')!;
    expect(host.querySelector('[data-testid="conversation-strip"]')).toBeNull();
    expect(pane.querySelector(".conversation-body")!.previousElementSibling).toBeNull();
  });

  it("takes no strip from the host: a snippet handed in the old way draws nowhere", async () => {
    const probe = createRawSnippet(() => ({ render: () => '<div data-testid="strip-probe">Syncing</div>' }));
    await mountConversation({ aboveMessages: probe });
    expect(host.querySelector('[data-testid="strip-probe"]')).toBeNull();
    expect(host.querySelector('[data-testid="conversation-strip"]')).toBeNull();
  });

  it("keeps a reader at the newest message there when the scroller changes height", async () => {
    await mountConversation({});
    const box = { viewport: 600 };
    const el = stubLayout(box);
    await scrollTo(el, 2400);
    resized();
    // The message box grows by a line: the scroller loses 32px. Without a
    // pin the newest message would sit 32px under the fold.
    box.viewport = 568;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
    // It shrinks again: the scroller is tall again and still at the bottom.
    box.viewport = 600;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
  });

  it("leaves a reader who scrolled up where they are", async () => {
    await mountConversation({});
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
