import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const replyPanelSrc = readFileSync(
  new URL("./ReplyPanel.svelte", import.meta.url),
  "utf8",
);
const channelConversationSrc = readFileSync(
  new URL("./ChannelConversation.svelte", import.meta.url),
  "utf8",
);
const messageRowCss = readFileSync(
  new URL("./message-row.css", import.meta.url),
  "utf8",
);

describe("shared message-row name→body spacing", () => {
  it("defines the shared spacing token and first-paragraph collapse", () => {
    expect(messageRowCss).toContain("--msg-name-body-gap: 0.125rem");
    expect(messageRowCss).toContain("--msg-avatar-pad-top: 2px");
    expect(messageRowCss).toContain("--msg-body-p-margin: 0.375rem 0");
    expect(messageRowCss).toMatch(/\.msg-body\s*>\s*:first-child\s*\{/);
    expect(messageRowCss).toMatch(/margin-top:\s*0/);
  });

  it("uses the shared class and token in both the main column and the thread panel", () => {
    expect(channelConversationSrc).toContain('import "./message-row.css"');
    expect(replyPanelSrc).toContain('import "./message-row.css"');
    expect(channelConversationSrc).toContain(
      'class="dm-bubble-body selectable-text msg-body"',
    );
    expect(replyPanelSrc).toContain('class="reply-md msg-body"');
    expect(channelConversationSrc).toContain(
      "margin: 0 0 var(--msg-name-body-gap, 0.125rem)",
    );
    expect(replyPanelSrc).toContain(
      "margin: 0 0 var(--msg-name-body-gap, 0.125rem)",
    );
    expect(replyPanelSrc).toMatch(/\.reply-col\s*\{[\s\S]*?gap:\s*0;/);
    expect(replyPanelSrc).toContain(
      "padding-top: var(--msg-avatar-pad-top, 2px)",
    );
    expect(channelConversationSrc).toContain(
      "padding-top: var(--msg-avatar-pad-top, 2px)",
    );
  });
});
