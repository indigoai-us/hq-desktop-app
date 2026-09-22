import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const channelConversationSrc = readFileSync(
  new URL("./ChannelConversation.svelte", import.meta.url),
  "utf8",
);
const replyPanelSrc = readFileSync(
  new URL("./ReplyPanel.svelte", import.meta.url),
  "utf8",
);
const chatTokensCss = readFileSync(
  new URL("../chat-tokens.css", import.meta.url),
  "utf8",
);

describe("message body link colour", () => {
  it("defines the link token from the violet interactive ink in both surfaces", () => {
    for (const src of [channelConversationSrc, replyPanelSrc]) {
      expect(src).toMatch(
        /--message-markdown-link:\s*var\(--vio-ink,\s*var\(--accent,\s*#e0c4fe\)\);/,
      );
    }
  });

  it("colours body anchors with the link token, not the muted body token", () => {
    expect(channelConversationSrc).toMatch(
      /\.dm-bubble-body :global\(a\),\s*\n\s*\.dm-bubble-body :global\(a:visited\) \{\s*\n\s*color: var\(--message-markdown-link\);/,
    );
    expect(replyPanelSrc).toMatch(
      /\.reply-md :global\(a\),\s*\n\s*\.reply-md :global\(a:visited\) \{\s*\n\s*color: var\(--message-markdown-link\);/,
    );
  });

  it("keeps the underline and brightens only on hover", () => {
    for (const src of [channelConversationSrc, replyPanelSrc]) {
      expect(src).toContain("text-decoration: underline");
      expect(src).toContain(
        "color: color-mix(in srgb, var(--message-markdown-link) 88%, var(--t1));",
      );
    }
  });

  it("resolves --vio-ink to an AA-contrast value in each theme", () => {
    // Dark shell default and forced-light override; both are AA (>= 4.5:1)
    // against their message background (#1e1e24 / #ffffff).
    expect(chatTokensCss).toContain("--vio-ink: #e0c4fe");
    expect(chatTokensCss).toContain("--vio-ink: #854dee");
  });
});
