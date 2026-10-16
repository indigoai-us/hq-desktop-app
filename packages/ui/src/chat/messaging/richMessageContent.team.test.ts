// The `team` hq-block: the setup bot's first question, "Who do you work with?",
// drawn by the host as a card under the message.

import { describe, expect, it } from "vitest";

import {
  extractRichContentFromBody,
  messageHasVisibleContent,
  parseRichContent,
  teamBlockInMessage,
} from "./richMessageContent";

/** The exact shape hq-cli sends in the setup bot's first message. */
const first =
  "Hi, I'm your setup assistant.\n\n" + "```hq-block\n" + JSON.stringify({ v: 1, blocks: [{ kind: "team" }] }) + "\n```";

describe("the team block", () => {
  it("is parsed from the bot's message, leaving only the sentence as text", () => {
    const { text, rich } = extractRichContentFromBody(first);
    expect(text.trim()).toBe("Hi, I'm your setup assistant.");
    expect(rich?.blocks).toEqual([{ kind: "team" }]);
    expect(teamBlockInMessage({ body: first })).toBe(true);
  });

  it("drops any extra fields the bot sends", () => {
    expect(parseRichContent({ v: 1, blocks: [{ kind: "team", options: ["x"] }] })?.blocks).toEqual([{ kind: "team" }]);
  });

  it("is host-placed: a message with only the block has no visible content of its own", () => {
    const body = "```hq-block\n" + JSON.stringify({ v: 1, blocks: [{ kind: "team" }] }) + "\n```";
    expect(messageHasVisibleContent({ body })).toBe(false);
  });

  it("is absent from a plain message", () => {
    expect(teamBlockInMessage({ body: "Hello" })).toBe(false);
    expect(teamBlockInMessage({ body: null })).toBe(false);
  });
});
