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
    expect(messageRowCss).toContain("--msg-name-body-gap: 0.1875rem");
    expect(messageRowCss).toContain("--msg-avatar-pad-top: 2px");
    expect(messageRowCss).toContain("--msg-body-p-margin: 0.375rem 0");
    expect(messageRowCss).toMatch(/\.msg-body\s*>\s*:first-child\s*\{/);
    expect(messageRowCss).toMatch(/margin-top:\s*0/);
  });

  it("pins the compact intra-group padding and inter-group gap tokens", () => {
    // 3px top + 3px bottom on adjacent same-author rows → ~6px stacked gap.
    expect(messageRowCss).toContain("--msg-row-pad-y: 3px");
    // Larger gap before a re-headered new-author group.
    expect(messageRowCss).toContain("--msg-group-gap: 12px");
  });

  it("wires the row-rhythm tokens into the main-column message rows", () => {
    // Continuation rows carry no extra top margin and use the compact pad.
    expect(channelConversationSrc).toMatch(
      /\.dm-msg\s*\{[\s\S]*?margin-top:\s*0;[\s\S]*?padding:\s*var\(--msg-row-pad-y, 3px\) 8px;/,
    );
    // A new author group gets the modest inter-group gap, not the old 10px.
    expect(channelConversationSrc).toMatch(
      /\.dm-msg-group-start\s*\{[\s\S]*?margin-top:\s*var\(--msg-group-gap, 12px\);/,
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
      "margin: 0 0 var(--msg-name-body-gap, 0.1875rem)",
    );
    expect(replyPanelSrc).toContain(
      "margin: 0 0 var(--msg-name-body-gap, 0.1875rem)",
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

describe("composer type matches message body type", () => {
  it("defines the shared body-font tokens", () => {
    expect(messageRowCss).toContain("--msg-body-font-family: var(--font-ui)");
    expect(messageRowCss).toContain("--msg-body-font-size: 15px");
    expect(messageRowCss).toContain("--msg-body-line-height: 1.7");
    expect(messageRowCss).toMatch(
      /--msg-body-font:\s*400 var\(--msg-body-font-size\) \/ var\(--msg-body-line-height\)\s*var\(--msg-body-font-family\);/,
    );
  });

  it("makes every message body read the tokens rather than literal sizes", () => {
    expect(channelConversationSrc).toMatch(
      /\.dm-bubble-body\s*\{[\s\S]*?font-family:\s*var\(--msg-body-font-family[\s\S]*?font-size:\s*var\(--msg-body-font-size[\s\S]*?line-height:\s*var\(--msg-body-line-height/,
    );
    expect(replyPanelSrc).toMatch(
      /\.reply-root-body,\s*\n\s*\.reply-md\s*\{[\s\S]*?font-family:\s*var\(--msg-body-font-family[\s\S]*?font-size:\s*var\(--msg-body-font-size[\s\S]*?line-height:\s*var\(--msg-body-line-height/,
    );
  });

  it("makes every composer read the same font token as the body", () => {
    const composerFont =
      "font: var(--msg-body-font, 400 15px / 1.7 var(--font-ui));";
    for (const [selector, src] of [
      [".dm-reply-input", channelConversationSrc],
      [".mention-input-overlay", channelConversationSrc],
      [".reply-input", replyPanelSrc],
    ] as const) {
      const rule = new RegExp(
        `\\${selector}\\s*\\{[\\s\\S]*?\\n  \\}`,
      ).exec(src)?.[0];
      expect(rule, `${selector} rule not found`).toBeTruthy();
      expect(rule).toContain(composerFont);
      // No literal font shorthand left to drift away from the body.
      expect(rule).not.toMatch(/font:\s*400 \d+px/);
    }
  });

  it("keeps the mention overlay mirror byte-identical to the composer input", () => {
    const fontDecl = (selector: string) =>
      new RegExp(`\\${selector}\\s*\\{[\\s\\S]*?\\n  \\}`)
        .exec(channelConversationSrc)?.[0]
        .match(/^\s*font:.*$/m)?.[0]
        .trim();
    expect(fontDecl(".mention-input-overlay")).toBe(
      fontDecl(".dm-reply-input"),
    );
    expect(fontDecl(".dm-reply-input")).toBeTruthy();
  });
});
