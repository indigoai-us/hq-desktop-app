// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "../chat/messaging/ChannelConversation.svelte";
import ReplyPanel from "../chat/messaging/ReplyPanel.svelte";
import type { ConversationApi } from "../chat/chat-api";
import {
  EMOJI_SHORTCODES,
  JUMBO_EMOJI_MAX,
  emojiForShortcode,
  emojiOnlyCount,
  isJumboEmojiBody,
  replaceEmojiShortcodes,
  replaceEmojiShortcodesInHtml,
} from "./emojiShortcodes.js";
import { renderMessageBodyMarkdown } from "./messageMarkdown.js";

describe("shortcode table", () => {
  it("covers the common Slack/GitHub set including aliases", () => {
    expect(EMOJI_SHORTCODES.size).toBeGreaterThan(400);
    expect(emojiForShortcode("smile")).toBe("😄");
    expect(emojiForShortcode(":tada:")).toBe("🎉");
    expect(emojiForShortcode("+1")).toBe("👍");
    expect(emojiForShortcode("thumbsup")).toBe("👍");
    expect(emojiForShortcode("SMILE")).toBe("😄");
    expect(emojiForShortcode("nope")).toBeNull();
  });
});

describe("replaceEmojiShortcodes", () => {
  it("converts known shortcodes in text", () => {
    expect(replaceEmojiShortcodes("banana :stuck_out_tongue_winking_eye:")).toBe(
      "banana 😜",
    );
  });

  it("leaves unknown shortcodes literal", () => {
    expect(replaceEmojiShortcodes("hey :nope: there")).toBe("hey :nope: there");
  });

  it("does not mangle clock times", () => {
    expect(replaceEmojiShortcodes("ship at 12:30:45")).toBe("ship at 12:30:45");
  });
});

describe("replaceEmojiShortcodesInHtml", () => {
  it("skips code, pre, and anchor contents but converts text runs", () => {
    const html =
      "<p>:smile: <code>:smile:</code></p><pre><code>:smile:</code></pre>" +
      '<p><a href="https://x.test/:smile:">https://x.test/:smile:</a> :tada:</p>';
    expect(replaceEmojiShortcodesInHtml(html)).toBe(
      "<p>😄 <code>:smile:</code></p><pre><code>:smile:</code></pre>" +
        '<p><a href="https://x.test/:smile:">https://x.test/:smile:</a> 🎉</p>',
    );
  });

  it("never rewrites tag attributes", () => {
    const html = '<img alt=":smile:" src="x.png">';
    expect(replaceEmojiShortcodesInHtml(html)).toBe(html);
  });
});

describe("message body rendering", () => {
  it("renders a shortcode in a normal message as the emoji", () => {
    expect(renderMessageBodyMarkdown("hello :smile:")).toContain("😄");
  });

  it("keeps an unknown shortcode literal", () => {
    expect(renderMessageBodyMarkdown("hello :nope:")).toContain(":nope:");
  });

  it("keeps shortcodes literal inside a code span", () => {
    const html = renderMessageBodyMarkdown("use `:smile:` here");
    expect(html).toContain("<code>:smile:</code>");
    expect(html).not.toContain("😄");
  });

  it("keeps shortcodes literal inside a fenced code block", () => {
    const html = renderMessageBodyMarkdown("```\n:smile:\n```");
    expect(html).toContain(":smile:");
    expect(html).not.toContain("😄");
  });

  it("leaves a URL containing a shortcode untouched", () => {
    const html = renderMessageBodyMarkdown("see https://x.test/a/:smile:/b");
    expect(html).toContain("https://x.test/a/:smile:/b");
    expect(html).not.toContain("😄");
  });

  it("leaves mention tokens unaffected", () => {
    const html = renderMessageBodyMarkdown("@Corey Epstein :tada:");
    expect(html).toContain("@Corey");
    expect(html).toContain("🎉");
  });
});

describe("jumbo emoji-only bodies", () => {
  it("treats a lone emoji (unicode or shortcode) as jumbo", () => {
    expect(isJumboEmojiBody("😜")).toBe(true);
    expect(isJumboEmojiBody(":stuck_out_tongue_winking_eye:")).toBe(true);
    expect(isJumboEmojiBody("  🎉  ")).toBe(true);
  });

  it("handles multi-codepoint emoji as one", () => {
    expect(emojiOnlyCount("❤️")).toBe(1);
    expect(emojiOnlyCount("👍🏽")).toBe(1);
  });

  it("allows up to the jumbo cap", () => {
    expect(JUMBO_EMOJI_MAX).toBe(3);
    expect(isJumboEmojiBody("😄 🎉 🚀")).toBe(true);
    expect(isJumboEmojiBody("😄 🎉 🚀 🔥")).toBe(false);
    expect(emojiOnlyCount("😄🎉🚀🔥")).toBe(4);
  });

  it("does not jumbo mixed text and emoji, or empty bodies", () => {
    expect(isJumboEmojiBody("banana 😜")).toBe(false);
    expect(isJumboEmojiBody(":smile: yes")).toBe(false);
    expect(isJumboEmojiBody("")).toBe(false);
    expect(isJumboEmojiBody("   ")).toBe(false);
    expect(isJumboEmojiBody(":nope:")).toBe(false);
  });
});

describe("jumbo emoji on a rendered message", () => {
  let host: HTMLDivElement | null = null;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
    host = null;
  });

  function mountConversation(body: string) {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelConversation, {
      target: host,
      props: {
        messages: [
          {
            eventId: "evt_jumbo",
            direction: "in",
            fromPersonUid: "prs_ada",
            fromDisplayName: "Ada",
            body,
            createdAt: "2026-08-28T01:14:00.000Z",
          },
        ],
      },
    });
  }

  it("marks an emoji-only conversation body as jumbo", async () => {
    mountConversation("🎉");
    await tick();
    const body = host!.querySelector(".msg-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("msg-body-jumbo")).toBe(true);
    expect(body!.textContent).toContain("🎉");
  });

  it("does not mark a sentence as jumbo", async () => {
    mountConversation("ship the chip");
    await tick();
    const body = host!.querySelector(".msg-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("msg-body-jumbo")).toBe(false);
  });

  it("marks an emoji-only thread root as jumbo", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const root = {
      eventId: "evt_root",
      direction: "in",
      fromPersonUid: "prs_ada",
      fromDisplayName: "Ada",
      body: "🎉",
      createdAt: "2026-08-28T01:14:00.000Z",
    };
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: {
          fetchReplyThread: async () => ({
            scope: "channel",
            root,
            replies: [],
            replyCount: 0,
          }),
          sendReply: async () => {},
        } as unknown as ConversationApi,
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: root,
        selfDisplayName: "Ada",
        onclose: () => {},
      },
    });
    await tick();
    const body = host.querySelector(".msg-body");
    expect(body).not.toBeNull();
    expect(body!.classList.contains("msg-body-jumbo")).toBe(true);
  });
});
