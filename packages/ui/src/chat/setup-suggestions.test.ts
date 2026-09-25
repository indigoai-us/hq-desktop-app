// The setup bot's suggested replies: an `hq-block` of kind `suggestions` it
// writes for its own message. The parser keeps them short, plain and few; the
// shell shows them only under the bot's newest message and only until the
// person writes again.

import { describe, expect, it } from "vitest";

import {
  HQ_BLOCK_FENCE_LANG,
  messageHasVisibleContent,
  parseRichContent,
  richContentForMessage,
  richContentToPlainText,
  suggestionsForMessage,
} from "./messaging/richMessageContent";
import { setupSuggestionsDue } from "./setup-bot";

const BOT = "agt_setup";
const ME = "prs_me";

function withSuggestions(text: string, items: unknown[]): string {
  return [text, "", "```" + HQ_BLOCK_FENCE_LANG, JSON.stringify({ v: 1, blocks: [{ kind: "suggestions", items }] }), "```"].join("\n");
}

const due = (messages: Array<{ fromPersonUid: string; body: string }>) =>
  setupSuggestionsDue(messages, BOT, messageHasVisibleContent, suggestionsForMessage);

describe("suggestions block", () => {
  it("keeps up to four short, distinct, plain-text items", () => {
    const parsed = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "suggestions",
          items: ["For a company", { label: "Just for me" }, "for a company", "", 42, "Explain HQ first", "Skip", "One too many"],
        },
      ],
    });
    expect(parsed?.blocks).toEqual([{ kind: "suggestions", items: ["For a company", "Just for me", "42", "Explain HQ first"] }]);
  });

  it("caps a long suggestion and drops a block with nothing usable", () => {
    const long = "x".repeat(200);
    const parsed = parseRichContent({ v: 1, blocks: [{ kind: "suggestions", items: [long] }] });
    const items = (parsed?.blocks[0] as { items: string[] }).items;
    expect(items[0].length).toBeLessThanOrEqual(80);
    expect(parseRichContent({ v: 1, blocks: [{ kind: "suggestions", items: [] }] })).toBeNull();
  });

  it("is lifted out of the message text and adds nothing to it", () => {
    const body = withSuggestions("Company or just you?", ["A company", "Just me"]);
    const { text, rich } = richContentForMessage({ body });
    expect(text.trim()).toBe("Company or just you?");
    expect(rich && richContentToPlainText(rich)).toBe("");
    expect(suggestionsForMessage({ body })).toEqual(["A company", "Just me"]);
  });

  it("does not count as visible content on its own", () => {
    expect(messageHasVisibleContent({ body: withSuggestions("", ["Yes"]) })).toBe(false);
  });
});

describe("an envelope of block kinds this version does not know", () => {
  it("is still lifted out of the text, so no raw machine text shows", () => {
    const body = [
      "Here you go.",
      "",
      "```" + HQ_BLOCK_FENCE_LANG,
      JSON.stringify({ v: 1, blocks: [{ kind: "someFutureKind", items: ["x"] }] }),
      "```",
    ].join("\n");
    const { text, rich } = richContentForMessage({ body });
    expect(text).toBe("Here you go.");
    expect(rich).toBeNull();
  });

  it("leaves ordinary JSON in a message alone", () => {
    const body = 'Config: {"v": 2, "blocks": ["a"]}';
    expect(richContentForMessage({ body }).text).toBe(body);
  });
});

describe("setupSuggestionsDue", () => {
  it("shows the bot's suggestions when its message is the newest", () => {
    expect(due([{ fromPersonUid: BOT, body: withSuggestions("Company or just you?", ["A company", "Just me"]) }])).toEqual([
      "A company",
      "Just me",
    ]);
  });

  it("puts them away once the person writes", () => {
    expect(
      due([
        { fromPersonUid: BOT, body: withSuggestions("Company or just you?", ["A company"]) },
        { fromPersonUid: ME, body: "A company" },
      ]),
    ).toEqual([]);
  });

  it("a newer bot message without suggestions replaces the old ones with nothing", () => {
    expect(
      due([
        { fromPersonUid: BOT, body: withSuggestions("Company or just you?", ["A company"]) },
        { fromPersonUid: BOT, body: "Creating it now." },
      ]),
    ).toEqual([]);
  });

  it("skips a newer bot message with nothing to read", () => {
    const marker = "```" + HQ_BLOCK_FENCE_LANG + "\n" + JSON.stringify({ v: 1, blocks: [{ kind: "setupDone" }] }) + "\n```";
    expect(
      due([
        { fromPersonUid: BOT, body: withSuggestions("Anything else?", ["Invite a teammate"]) },
        { fromPersonUid: BOT, body: marker },
      ]),
    ).toEqual(["Invite a teammate"]);
  });

  it("is empty without a bot id", () => {
    expect(setupSuggestionsDue([{ fromPersonUid: BOT, body: withSuggestions("Hi", ["Yes"]) }], " ", messageHasVisibleContent, suggestionsForMessage)).toEqual([]);
  });
});
