// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const root = {
  eventId: "evt_root",
  direction: "in",
  fromPersonUid: "prs_corey",
  fromDisplayName: "Corey Epstein",
  body: "deacon, pick up US-014",
  createdAt: "2026-10-01T09:31:00.000Z",
};

async function mountPanel(props: Record<string, unknown> = {}) {
  const sendReply = vi.fn(async () => {});
  const sendChannelMessage = vi.fn(async () => {});
  const api = {
    fetchReplyThread: async () => ({ scope: "channel", root, replies: [], replyCount: 0 }),
    sendReply,
    sendChannelMessage,
  } as unknown as ConversationApi;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api,
      rootEventId: "evt_root",
      scope: "channel",
      channelId: "chn_1",
      channelName: "hq-desktop-app",
      seedRoot: root,
      onclose: () => {},
      ...props,
    },
  });
  for (let i = 0; i < 4; i++) {
    await tick();
    await Promise.resolve();
  }
  return { sendReply, sendChannelMessage };
}

async function send(text: string) {
  const composer = host.querySelector('[data-testid="reply-panel-composer"]') as HTMLTextAreaElement;
  composer.value = text;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
}

describe("US-015 thread pane: Also send to #channel (home-thread)", () => {
  it("shows the switch and the channel label in the header", async () => {
    await mountPanel();
    expect(host.querySelector('[data-testid="reply-panel-also-send"]')?.textContent?.trim()).toBe(
      "Also send to #hq-desktop-app",
    );
    expect(host.querySelector('[data-testid="reply-panel-sub"]')?.textContent).toBe("#hq-desktop-app");
  });

  it("only replies in the thread when the switch is off", async () => {
    const { sendReply, sendChannelMessage } = await mountPanel();
    await send("on it");
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendChannelMessage).not.toHaveBeenCalled();
  });

  it("echoes the reply to the channel when the switch is on, then resets it", async () => {
    const { sendReply, sendChannelMessage } = await mountPanel();
    const input = host.querySelector('[data-testid="reply-panel-also-send"] input') as HTMLInputElement;
    input.click();
    await tick();
    expect(input.checked).toBe(true);
    await send("shipping today");
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendChannelMessage).toHaveBeenCalledWith({ channelId: "chn_1", body: "shipping today" });
    expect(input.checked).toBe(false);
  });

  it("hides the switch in DM threads", async () => {
    await mountPanel({ scope: "dm", channelId: null, withPersonUid: "prs_x" });
    expect(host.querySelector('[data-testid="reply-panel-also-send"]')).toBeNull();
  });
});
