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

function mountWith(
  messages: ReturnType<typeof message>[],
  onreply: ((rootEventId: string) => void) | null = () => {},
  extraProps: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: { messages, ...(onreply ? { onreply } : {}), ...extraProps },
  });
}

const copyButtons = () =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>('[data-testid="message-copy"]'));

describe("ChannelConversation Reply in thread (B-5)", () => {
  it("is offered where the host opens threads, and opens the thread of that message", async () => {
    const opened: string[] = [];
    mountWith([message(1)], (id) => opened.push(id));
    await tick();
    const reply = host!.querySelector<HTMLButtonElement>('[data-testid="message-reply-quick"]');
    expect(reply?.getAttribute("aria-label")).toBe("Reply in thread");
    reply!.click();
    expect(opened).toHaveLength(1);
  });

  it("is not drawn where the host opens no threads: Copy is still there", async () => {
    mountWith([message(1)], null);
    await tick();
    expect(host!.querySelector('[data-testid="message-reply-quick"]')).toBeNull();
    expect(copyButtons()).toHaveLength(1);
  });
});

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

describe("ChannelConversation Copy ID and Copy link", () => {
  const byId = (id: string) =>
    host!.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

  it("Copy ID writes the raw event id and confirms with Copied", async () => {
    vi.useFakeTimers();
    mountWith([message(1)], () => {}, { channelId: "chn_eng", companyUid: "cmp_1" });
    await tick();
    const button = byId("message-copy-id")!;
    expect(button.textContent?.trim()).toBe("Copy ID");
    button.click();
    await vi.advanceTimersByTimeAsync(0);
    await tick();
    expect(writeText).toHaveBeenCalledWith("evt_1");
    expect(button.textContent?.trim()).toBe("Copied");
    expect(byId("message-copy")!.textContent?.trim()).toBe("Copy");
    await vi.advanceTimersByTimeAsync(1600);
    await tick();
    expect(button.textContent?.trim()).toBe("Copy ID");
  });

  it("Copy link writes the long form with the company for a channel message", async () => {
    mountWith([message(1)], () => {}, { channelId: "chn_eng", companyUid: "cmp_1" });
    await tick();
    byId("message-copy-link")!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(
      "https://work.hq.computer/conversation/cmp_1/chn_eng/message/evt_1",
    );
  });

  it("Copy link names the other person in a DM", async () => {
    mountWith([message(1)], () => {}, { peerPersonUid: "psn_ada", companyUid: "cmp_1" });
    await tick();
    byId("message-copy-link")!.click();
    await tick();
    expect(writeText).toHaveBeenCalledWith(
      "https://work.hq.computer/conversation/cmp_1/psn_ada/message/evt_1",
    );
  });

  it("offers no Copy link without a company, and no actions on unsent messages", async () => {
    mountWith([message(1), message(2, { eventId: "local-2" })], () => {}, {
      channelId: "chn_eng",
    });
    await tick();
    expect(host!.querySelectorAll('[data-testid="message-copy-link"]')).toHaveLength(0);
    expect(host!.querySelectorAll('[data-testid="message-copy-id"]')).toHaveLength(1);
  });
});
