// @vitest-environment happy-dom

/**
 * The area pinned under the thread: the host's row (a bot's file sync), the
 * suggested replies, the message box. None of it scrolls with the messages.
 * When it grows or shrinks the scroller changes height: a reader at the
 * newest message stays there, and a reader who scrolled up is not moved.
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

function messages(count: number): ConversationMessageWire[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `evt_${i + 1}`,
    direction: "in",
    fromPersonUid: "agt_nova",
    fromDisplayName: "Nova",
    body: `message ${i + 1}`,
    createdAt: new Date(Date.UTC(2026, 9, 2, 14, i)).toISOString(),
  })) as ConversationMessageWire[];
}

const probe = createRawSnippet(() => ({ render: () => '<div data-testid="pinned-probe">Syncing</div>' }));
const thinking = createRawSnippet(() => ({ render: () => '<div data-testid="thinking-probe">Nova is thinking</div>' }));

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
  it("draws the host's row under the thread, then the suggested replies, then the message box", async () => {
    await mountConversation({ aboveComposer: probe, belowMessages: thinking, suggestedReplies: ["Yes", "Not yet"] });
    const row = host.querySelector<HTMLElement>('[data-testid="pinned-probe"]')!;
    // The status row (a bot thinking) is still the last row of the thread itself.
    const lastRow = host.querySelector<HTMLElement>('[data-testid="thinking-probe"]')!;
    expect(thread().contains(lastRow)).toBe(true);
    expect(before(lastRow, row)).toBe(true);
    const chips = host.querySelector<HTMLElement>('[data-testid="suggested-replies"]')!;
    const box = host.querySelector<HTMLElement>('[data-testid="conversation-composer"]')!;
    expect(row).not.toBeNull();
    // Not in the scroller: it stays in view while the person scrolls.
    expect(thread().contains(row)).toBe(false);
    expect(thread().contains(chips)).toBe(false);
    expect(row.closest('[data-testid="conversation-pinned"]')).not.toBeNull();
    expect(before(thread(), row)).toBe(true);
    expect(before(row, chips)).toBe(true);
    expect(before(chips, box)).toBe(true);
  });

  it("has no pinned row when the host gives none, or in a header-only pane", async () => {
    await mountConversation({});
    expect(host.querySelector('[data-testid="conversation-pinned"]')).toBeNull();
    await unmount(component!);
    component = null;
    host.remove();
    await mountConversation({ aboveComposer: probe, headerOnly: true });
    expect(host.querySelector('[data-testid="pinned-probe"]')).toBeNull();
  });

  it("keeps a reader at the newest message there when the pinned area takes room", async () => {
    await mountConversation({ aboveComposer: probe });
    const box = { viewport: 600 };
    const el = stubLayout(box);
    await scrollTo(el, 2400);
    resized();
    // The sync row appears: the scroller loses 60px. Without a pin the newest
    // message would sit 60px under the fold.
    box.viewport = 540;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
    // The row goes: the scroller is tall again and still at the bottom.
    box.viewport = 600;
    el.scrollTop = 2400;
    resized();
    expect(el.scrollTop).toBe(3000);
  });

  it("leaves a reader who scrolled up where they are", async () => {
    await mountConversation({ aboveComposer: probe });
    const box = { viewport: 600 };
    const el = stubLayout(box);
    await scrollTo(el, 2400);
    resized();
    await scrollTo(el, 900);
    box.viewport = 540;
    resized();
    expect(el.scrollTop).toBe(900);
    box.viewport = 600;
    resized();
    expect(el.scrollTop).toBe(900);
  });
});
