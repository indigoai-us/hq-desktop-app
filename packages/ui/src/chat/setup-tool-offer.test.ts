// The setup bot's "continue setup in your coding tool" offer, on the app side:
// the hq-block contract, when the card shows, and what the tool receives.

import { describe, expect, it } from "vitest";

import {
  continueInToolForMessage,
  extractRichContentFromBody,
  messageHasVisibleContent,
  parseRichContent,
  richContentToPlainText,
  suggestionsForMessage,
} from "./messaging/richMessageContent";
import { SETUP_CONTINUE_IN_TOOL_PROMPT, SETUP_KEEP_GOING_HERE, SETUP_TOOL_OFFER_COPY, setupToolOfferDue } from "./setup-bot";
import { SETUP_SKILL_PATH } from "./setup-channel";

const BOT = "agt_setup";
const ME = "prs_me";
/** Exactly what hq-cli sends (setup-tool-offer.ts `setupToolOfferText`). */
const offer = (tool: string) =>
  `I see you use ${tool === "claude" ? "Claude Code" : "Codex"} a lot. Want to continue setup there?\n\n` +
  "```hq-block\n" +
  JSON.stringify({ v: 1, blocks: [{ kind: "continueInTool", tool }, { kind: "suggestions", items: ["Keep going here"] }] }) +
  "\n```";

describe("the continueInTool block", () => {
  it("is parsed from the bot's message, leaving only the sentence as text", () => {
    const { text, rich } = extractRichContentFromBody(offer("claude"));
    expect(text.trim()).toBe("I see you use Claude Code a lot. Want to continue setup there?");
    expect(rich?.blocks).toEqual([
      { kind: "continueInTool", tool: "claude" },
      { kind: "suggestions", items: ["Keep going here"] },
    ]);
    expect(continueInToolForMessage({ body: offer("codex") })).toBe("codex");
    expect(suggestionsForMessage({ body: offer("claude") })).toEqual([SETUP_KEEP_GOING_HERE]);
  });

  it("only names Claude Code or Codex; any other tool drops the block", () => {
    expect(parseRichContent({ v: 1, blocks: [{ kind: "continueInTool", tool: "cursor" }] })).toBeNull();
    expect(parseRichContent({ v: 1, blocks: [{ kind: "continueInTool" }] })).toBeNull();
    expect(continueInToolForMessage({ body: "Just text." })).toBeNull();
  });

  it("is placed by the host: it adds no text of its own and no bubble on its own", () => {
    const model = parseRichContent({ v: 1, blocks: [{ kind: "continueInTool", tool: "claude" }] })!;
    expect(richContentToPlainText(model)).toBe("");
    expect(messageHasVisibleContent({ richContent: { v: 1, blocks: [{ kind: "continueInTool", tool: "claude" }] } })).toBe(false);
    expect(messageHasVisibleContent({ body: offer("claude") })).toBe(true);
  });
});

describe("setupToolOfferDue", () => {
  const msg = (from: string, body: string) => ({ fromPersonUid: from, body });
  const due = (messages: Array<{ fromPersonUid: string; body: string }>) =>
    setupToolOfferDue(messages, BOT, messageHasVisibleContent, continueInToolForMessage);

  it("shows the card under the bot's offer", () => {
    expect(due([msg(BOT, "Hi, I'm Banjo."), msg(BOT, offer("claude"))])).toBe("claude");
    expect(due([msg(BOT, offer("codex"))])).toBe("codex");
  });

  it("puts it away once the person writes (a click on Keep going here included)", () => {
    expect(due([msg(BOT, offer("claude")), msg(ME, SETUP_KEEP_GOING_HERE)])).toBeNull();
    expect(due([msg(BOT, offer("claude")), msg(ME, "hey")])).toBeNull();
  });

  it("puts it away when the bot moves on, and never shows without the block", () => {
    expect(due([msg(BOT, offer("claude")), msg(ME, "ok"), msg(BOT, "Your tools are all here.")])).toBeNull();
    expect(due([msg(BOT, "Your tools are all here.")])).toBeNull();
    expect(due([])).toBeNull();
    expect(setupToolOfferDue([msg(BOT, offer("claude"))], "  ", messageHasVisibleContent, continueInToolForMessage)).toBeNull();
  });
});

describe("what the coding tool receives", () => {
  it("is a plain-language request to run HQ setup in this folder", () => {
    expect(SETUP_CONTINUE_IN_TOOL_PROMPT.startsWith("Please set up HQ with me in this folder.")).toBe(true);
    expect(SETUP_CONTINUE_IN_TOOL_PROMPT).toContain(SETUP_SKILL_PATH);
    // Never a slash command: a leading "/" is parsed as one, and the person is never told to type one.
    expect(SETUP_CONTINUE_IN_TOOL_PROMPT.trimStart().startsWith("/")).toBe(false);
    expect(SETUP_CONTINUE_IN_TOOL_PROMPT).not.toMatch(/(^|\s)\/setup\b/);
  });

  it("the card's own copy never tells anyone to type a command", () => {
    const all = JSON.stringify(SETUP_TOOL_OFFER_COPY);
    expect(all).not.toMatch(/(^|[\s"])\/[a-z]/);
    expect(SETUP_TOOL_OFFER_COPY.claude.continue).toBe("Continue in Claude Code");
    expect(SETUP_TOOL_OFFER_COPY.codex.continue).toBe("Continue in Codex");
    expect(SETUP_TOOL_OFFER_COPY.keep).toBe("Keep going here");
  });
});
