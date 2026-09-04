import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("jumbo wiring (source contract)", () => {
  const read = (relative: string): string =>
    readFileSync(new URL(relative, import.meta.url), "utf8");

  it("styles the jumbo class in the shared message-row stylesheet", () => {
    const css = read("../chat/messaging/message-row.css");
    expect(css).toContain(".msg-body.msg-body-jumbo");
    expect(css).toContain("--msg-jumbo-emoji-size, 30px");
  });

  it("applies the jumbo class from the shared predicate on every body surface", () => {
    for (const file of [
      "../chat/messaging/ChannelConversation.svelte",
      "../chat/messaging/ReplyPanel.svelte",
    ]) {
      const src = read(file);
      expect(src).toContain("isJumboEmojiBody");
      expect(src).toContain("class:msg-body-jumbo={isJumboEmojiBody(");
    }
  });

  it("routes bodies through emoji conversion after autolinking", () => {
    const src = read("./messageMarkdown.ts");
    expect(src).toMatch(
      /replaceEmojiShortcodesInHtml\(\s*\n\s*autolinkMessageUrls\(/,
    );
  });
});
