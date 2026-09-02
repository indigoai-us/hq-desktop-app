// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import { loadDraft, saveDraft, type DraftStorage } from "./composer-drafts";

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
    storage: DraftStorage,
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

  it("keeps retrying a draft whose write storage rejected", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    let failing = true;
    const flaky = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem: (k: string, v: string) => {
        if (failing) throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(k, v);
      },
    };
    const composer = mountWithDraft(flaky);
    await tick();
    composer.value = "first";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    vi.advanceTimersByTime(400);
    expect(loadDraft(storage, "ch:chn_a"), "write rejected").toBe("");

    // Storage recovers; the next change retries and persists.
    failing = false;
    composer.value = "first, then more";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    vi.advanceTimersByTime(400);
    expect(loadDraft(storage, "ch:chn_a")).toBe("first, then more");
  });

  it("re-attempts a rejected write on unmount instead of treating it as saved", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    let failing = true;
    const flaky = {
      getItem: storage.getItem,
      removeItem: storage.removeItem,
      setItem: (k: string, v: string) => {
        if (failing) throw new DOMException("quota", "QuotaExceededError");
        storage.setItem(k, v);
      },
    };
    const composer = mountWithDraft(flaky);
    await tick();
    composer.value = "unsaved";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    vi.advanceTimersByTime(400);
    expect(loadDraft(storage, "ch:chn_a")).toBe("");
    failing = false;
    await unmount(component!);
    component = null;
    expect(loadDraft(storage, "ch:chn_a"), "destroy flush retried").toBe(
      "unsaved",
    );
  });

  it("restores the text and re-persists the draft when onsend rejects", async () => {
    const storage = memoryStorage();
    saveDraft(storage, "ch:chn_a", "please send me");
    const composer = mountWithDraft(storage, async () => {
      throw new Error("network down");
    });
    await tick();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    // Optimistic clear happened first…
    expect(composer.value).toBe("");
    await vi.waitFor(() => {
      expect(composer.value).toBe("please send me");
    });
    expect(loadDraft(storage, "ch:chn_a")).toBe("please send me");
    expect(host.textContent).toContain("network down");
  });

  it("does not clobber new typing when a slow send finally fails", async () => {
    const storage = memoryStorage();
    let reject!: (e: Error) => void;
    const composer = mountWithDraft(
      storage,
      () =>
        new Promise<void>((_, rej) => {
          reject = rej;
        }),
    );
    await tick();
    composer.value = "first message";
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();
    expect(composer.value).toBe("");
    composer.value = "second thought";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    reject(new Error("timeout"));
    await vi.waitFor(() => {
      expect(host.textContent).toContain("timeout");
    });
    expect(composer.value).toBe("second thought");
    await vi.waitFor(() => {
      expect(loadDraft(storage, "ch:chn_a")).toBe("second thought");
    });
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
