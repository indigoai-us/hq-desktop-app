// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { loadDraft, saveDraft } from "./composer-drafts";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountComposer(onsend?: (body: string) => void): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      onsend,
    },
  });
  return host;
}

describe("ChannelConversation composer", () => {
  it("enables send after input and submits the draft", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    const sendBtn = root.querySelector(
      '[data-testid="composer-send"]',
    ) as HTMLButtonElement;
    expect(sendBtn.getAttribute("aria-disabled")).toBe("true");
    expect(composer.getAttribute("data-gramm")).toBe("false");
    expect(composer.getAttribute("data-enable-grammarly")).toBe("false");
    composer.value = "hello deacon";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(sendBtn.getAttribute("aria-disabled")).toBe("false");
    sendBtn.click();
    await tick();
    expect(sent).toEqual(["hello deacon"]);
  });

  it("sends the native textarea value on Enter even if bind lagged", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "typed without svelte bind";
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(sent).toEqual(["typed without svelte bind"]);
  });

  it("keeps the send control clickable so a DOM-synced draft can submit", async () => {
    const sent: string[] = [];
    const root = mountComposer((body) => {
      sent.push(body);
    });
    await tick();
    const composer = root.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    const sendBtn = root.querySelector(
      '[data-testid="composer-send"]',
    ) as HTMLButtonElement;
    composer.value = "click send";
    expect(sendBtn.disabled).toBe(false);
    sendBtn.click();
    await tick();
    expect(sent).toEqual(["click send"]);
  });
});

describe("ChannelConversation composer drafts", () => {
  function memoryStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  function mountWithDraft(
    storage: ReturnType<typeof memoryStorage>,
    onsend?: (body: string) => void | Promise<void>,
  ): HTMLTextAreaElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [],
        onsend,
        draftKey: "ch:chn_a",
        draftStorage: storage,
      },
    });
    return host.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores a stored draft on mount and enables send", async () => {
    const storage = memoryStorage();
    saveDraft(storage, "ch:chn_a", "half-written thought");
    saveDraft(storage, "ch:chn_b", "someone else's draft");
    const composer = mountWithDraft(storage);
    await tick();
    expect(composer.value).toBe("half-written thought");
    expect(
      host
        .querySelector('[data-testid="composer-send"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("false");
  });

  it("saves typed text after the debounce, not on every keystroke", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const composer = mountWithDraft(storage);
    await tick();
    composer.value = "typing";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(loadDraft(storage, "ch:chn_a")).toBe("");
    vi.advanceTimersByTime(100);
    composer.value = "typing more";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    vi.advanceTimersByTime(250);
    expect(loadDraft(storage, "ch:chn_a"), "debounce restarted").toBe("");
    vi.advanceTimersByTime(100);
    expect(loadDraft(storage, "ch:chn_a")).toBe("typing more");
  });

  it("flushes a pending draft when unmounted mid-debounce", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const composer = mountWithDraft(storage);
    await tick();
    composer.value = "leaving now";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(loadDraft(storage, "ch:chn_a")).toBe("");
    await unmount(component!);
    component = null;
    expect(loadDraft(storage, "ch:chn_a")).toBe("leaving now");
  });

  it("clears the draft on send", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    saveDraft(storage, "ch:chn_a", "ready to go");
    const sent: string[] = [];
    const composer = mountWithDraft(storage, (body) => {
      sent.push(body);
    });
    await tick();
    expect(composer.value).toBe("ready to go");
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(sent).toEqual(["ready to go"]);
    expect(loadDraft(storage, "ch:chn_a")).toBe("");
    expect(composer.value).toBe("");
    // No stale debounced write resurrects it.
    vi.advanceTimersByTime(1_000);
    await tick();
    expect(loadDraft(storage, "ch:chn_a")).toBe("");
  });

  it("does nothing without a draft key / storage", async () => {
    const storage = memoryStorage();
    saveDraft(storage, "ch:chn_a", "stored");
    mountComposer();
    await tick();
    const composer = host.querySelector(
      '[data-testid="conversation-composer"]',
    ) as HTMLTextAreaElement;
    expect(composer.value).toBe("");
  });
});
