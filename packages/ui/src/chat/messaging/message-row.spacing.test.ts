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

  it("pins the compact intra-group padding and inter-group gap tokens", () => {
    // 1px top + 1px bottom on adjacent same-author rows → ~2px stacked gap.
    expect(messageRowCss).toContain("--msg-row-pad-y: 1px");
    // Modest gap before a re-headered new-author group.
    expect(messageRowCss).toContain("--msg-group-gap: 8px");
  });

  it("wires the row-rhythm tokens into the main-column message rows", () => {
    // Continuation rows carry no extra top margin and use the compact pad.
    expect(channelConversationSrc).toMatch(
      /\.dm-msg\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?padding:\s*var\(--msg-row-pad-y, 1px\) 8px;/,
    );
    // A new author group gets the modest inter-group gap, not the old 10px.
    expect(channelConversationSrc).toMatch(
      /\.dm-msg-group-start\s*\{[\s\S]*?margin-top:\s*var\(--msg-group-gap, 8px\);/,
    );
    expect(channelConversationSrc).not.toContain("margin-top: 10px");
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
