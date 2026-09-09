// @vitest-environment happy-dom

/**
 * Scroll ownership regression tests.
 *
 * Bug (shipped in v0.10.173-beta.2): an ungated `$effect` in
 * ChannelConversation.svelte slammed the `.dm-thread` scroller to the bottom on
 * every change of `timeline.length`. Because the host repolls messages every few
 * seconds, a user who scrolled up to read history was yanked back down.
 *
 * happy-dom does no layout, so `scrollHeight` / `clientHeight` are 0 and
 * `scrollTop` is never clamped. We stub those three so the component's
 * distance-from-bottom arithmetic has real numbers to work with.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const VIEWPORT = 300;
/** Pretend each message row occupies this much vertical space. */
const ROW_HEIGHT = 100;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function message(n: number): ConversationMessageWire {
  return {
    eventId: `evt_${n}`,
    direction: "in",
    fromPersonUid: "prs_ada",
    fromDisplayName: "Ada",
    body: `message ${n}`,
    createdAt: new Date(Date.UTC(2026, 7, 28, 0, n)).toISOString(),
  } as ConversationMessageWire;
}

function messages(count: number): ConversationMessageWire[] {
  return Array.from({ length: count }, (_, i) => message(i + 1));
}

/**
 * Mount with a reactive props object so the test can mutate `props.messages`
 * the way the polling host does, without remounting.
 */
function mountConversation(initial: ConversationMessageWire[]) {
  const props = $state({ messages: initial });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, { target: host, props });
  return props;
}

/** Give the scroller a fake layout box driven by the current row count. */
function stubLayout(rowCount: number): HTMLElement {
  const el = host.querySelector(
    '[data-testid="conversation-thread"]',
  ) as HTMLElement;
  expect(el).not.toBeNull();
  Object.defineProperty(el, "clientHeight", {
    value: VIEWPORT,
    configurable: true,
  });
  Object.defineProperty(el, "scrollHeight", {
    get: () => rowCountRef.value * ROW_HEIGHT,
    configurable: true,
  });
  rowCountRef.value = rowCount;
  return el;
}

/** Mutable box so the stubbed scrollHeight grows as messages are appended. */
const rowCountRef = { value: 0 };

function thread(): HTMLElement {
  return host.querySelector(
    '[data-testid="conversation-thread"]',
  ) as HTMLElement;
}

/** Drive the component's scroll handler the way a real user scroll would. */
function scrollTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
}

describe("ChannelConversation scroll ownership", () => {
  it("loads the next history page when the user reaches the top", async () => {
    mountConversation(messages(60));
    await tick();
    const el = stubLayout(20);

    // Loading more messages keeps the current first row anchored, so the
    // user's next upward scroll continues naturally into the new page.
    scrollTo(el, 0);
    rowCountRef.value = 40;
    await tick();
    await tick();

    expect(el.scrollTop).toBe(20 * ROW_HEIGHT);
    expect(
      host.querySelector('[data-testid="conversation-load-earlier"]')?.textContent,
    ).toContain("20 earlier");
  });

  it("requests remote history once, shows loading, and allows retry after failure", async () => {
    let calls = 0;
    let finish!: () => void;
    let fail!: (error: Error) => void;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, { target: host, props: {
      messages: messages(10), hasEarlier: true,
      onloadearlier: () => {
        calls++;
        return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
      },
    }});
    await tick();
    const el = stubLayout(10);
    scrollTo(el, 0);
    await tick();
    expect(host.querySelector('[role="status"]')?.textContent).toContain("Loading earlier messages");
    scrollTo(el, 0);
    expect(calls).toBe(1);
    fail(new Error("offline"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
    const retry = host.querySelector('[data-testid="conversation-load-earlier"]') as HTMLButtonElement;
    expect(retry.textContent).toContain("Retry");
    retry.click();
    await tick();
    expect(calls).toBe(2);
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps automatically loaded history when a live refresh arrives", async () => {
    const props = mountConversation(messages(60));
    await tick();
    const el = stubLayout(20);
    scrollTo(el, 0);
    rowCountRef.value = 40;
    await tick();

    // A new message must not reset the user's already-open history page.
    rowCountRef.value = 41;
    props.messages = messages(61);
    await tick();
    expect(
      host.querySelector('[data-testid="conversation-load-earlier"]')?.textContent,
    ).toContain("21 earlier");
  });

  it("lands at the bottom on initial mount", async () => {
    mountConversation(messages(10));
    await tick();
    const el = stubLayout(10);
    // Re-run the sticky effect now that the stubbed box has height.
    scrollTo(el, el.scrollHeight - VIEWPORT);
    await tick();

    expect(el.scrollTop).toBe(el.scrollHeight - VIEWPORT);
  });

  it("stays pinned to the bottom when a message arrives while stuck", async () => {
    const props = mountConversation(messages(10));
    await tick();
    const el = stubLayout(10);
    scrollTo(el, el.scrollHeight - VIEWPORT);
    await tick();

    // A poll delivers one more message while the user sits at the bottom.
    rowCountRef.value = 11;
    props.messages = messages(11);
    await tick();

    expect(el.scrollTop).toBe(el.scrollHeight);
    // No "jump to latest" pill while pinned.
    expect(
      host.querySelector('[data-testid="conversation-jump-latest"]'),
    ).toBeNull();
  });

  it("does NOT move the user when a message arrives while scrolled up", async () => {
    const props = mountConversation(messages(10));
    await tick();
    const el = stubLayout(10);

    // User scrolls up into history, far from the bottom.
    scrollTo(el, 120);
    await tick();
    expect(el.scrollTop).toBe(120);

    // The host's periodic refresh appends a message — the regression trigger.
    rowCountRef.value = 11;
    props.messages = messages(11);
    await tick();

    expect(el.scrollTop).toBe(120);

    // And the user is told there is something new rather than being moved.
    const jump = host.querySelector(
      '[data-testid="conversation-jump-latest"]',
    ) as HTMLButtonElement | null;
    expect(jump).not.toBeNull();
    expect(jump?.textContent).toContain("New messages");
  });

  it("re-sticks to the bottom on channel switch (fresh mount)", async () => {
    const props = mountConversation(messages(10));
    await tick();
    const first = stubLayout(10);
    scrollTo(first, 120);
    await tick();
    expect(first.scrollTop).toBe(120);

    // The host wraps this component in {#key selectedRow.id}, so switching
    // channels remounts it. Model that by unmounting and mounting afresh.
    await unmount(component!);
    component = null;
    host.remove();
    void props;

    mountConversation(messages(6));
    await tick();
    const second = stubLayout(6);
    scrollTo(second, second.scrollHeight - VIEWPORT);
    await tick();

    expect(second.scrollTop).toBe(second.scrollHeight - VIEWPORT);
    expect(
      host.querySelector('[data-testid="conversation-jump-latest"]'),
    ).toBeNull();
  });

  it("jump-to-latest returns the user to the bottom and re-arms stickiness", async () => {
    const props = mountConversation(messages(10));
    await tick();
    const el = stubLayout(10);
    scrollTo(el, 120);
    await tick();

    rowCountRef.value = 11;
    props.messages = messages(11);
    await tick();

    const jump = host.querySelector(
      '[data-testid="conversation-jump-latest"]',
    ) as HTMLButtonElement;
    jump.click();
    await tick();

    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(thread()).not.toBeNull();

    // Now pinned again: a further arrival should follow.
    rowCountRef.value = 12;
    props.messages = messages(12);
    await tick();
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("restores a message anchor and does not follow new messages", async () => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetTop",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get() {
        return this.getAttribute?.("data-event-id") === "evt_3" ? 200 : 0;
      },
    });
    try {
      const props = $state({
        messages: messages(10),
        restoreScroll: {
          kind: "message" as const,
          id: "evt_3",
          offset: 200,
        },
      });
      host = document.createElement("div");
      document.body.appendChild(host);
      component = mount(ChannelConversation, { target: host, props });
      await tick();
      const el = stubLayout(10);
      expect(el.querySelector("[data-event-id='evt_3']")).not.toBeNull();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(el.scrollTop).toBe(200);

      rowCountRef.value = 11;
      props.messages = messages(11);
      await tick();
      expect(el.scrollTop).toBe(200);
      expect(
        host.querySelector('[data-testid="conversation-jump-latest"]'),
      ).not.toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetTop", original);
      else delete (HTMLElement.prototype as { offsetTop?: unknown }).offsetTop;
    }
  });
});
