// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";

/**
 * Message-level "Copy" action: sits next to Reply in the hover toolbar,
 * writes the visible text (body + details) to the clipboard, and briefly
 * confirms with "Copied". Rows with nothing copyable (attachment-only) get
 * no button.
 */

let component: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function message(i: number, extra: Record<string, unknown> = {}) {
  return {
    eventId: `evt_${i}`,
    channelId: "setup",
    fromPersonUid: "prs_1",
    fromDisplayName: "HQ",
    body: `message ${i}`,
    createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    ...extra,
  };
}

function mountWith(messages: ReturnType<typeof message>[]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, { target: host, props: { messages } });
}

const copyButtons = () =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-testid="message-copy"]'));

describe("ChannelConversation message Copy action", () => {
  it("renders Copy right after Reply in the message toolbar", async () => {
    mountWith([message(1)]);
    await tick();
    const reply = host!.querySelector('[data-testid="message-reply-quick"]');
    expect(reply).not.toBeNull();
    const copy = copyButtons()[0];
    expect(copy).toBeDefined();
    expect(copy.textContent?.trim()).toBe("Copy");
    expect(reply!.nextElementSibling).toBe(copy);
  });

  it("writes body + details to the clipboard and confirms with Copied", async () => {
    vi.useFakeTimers();
    mountWith([message(1, { details: "more context" })]);
    await tick();
    const copy = copyButtons()[0];
    copy.click();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(writeText).toHaveBeenCalledWith("message 1\n\nmore context");
    expect(copy.textContent?.trim()).toBe("Copied");
    await vi.advanceTimersByTimeAsync(1600);
    await tick();
    expect(copy.textContent?.trim()).toBe("Copy");
  });

  it("omits Copy on rows with no copyable text", async () => {
    mountWith([
      message(1, {
        body: "",
        attachments: [
          { key: "k1", name: "photo.png", size: 10, contentType: "image/png" },
        ],
      }),
    ]);
    await tick();
    expect(copyButtons()).toHaveLength(0);
  });
});
