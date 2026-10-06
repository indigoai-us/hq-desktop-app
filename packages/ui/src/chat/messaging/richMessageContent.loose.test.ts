/**
 * The finish marker must never reach the conversation as text.
 *
 * The setup bot is told to wrap its envelope in an ```hq-block fence. It
 * sometimes drops the label, and the raw JSON then rendered as a code block in
 * the person's chat. An unlabelled fence and a bare line are lifted too.
 */
import { describe, expect, it } from "vitest";
import {
  extractRichContentFromBody,
  messageHasVisibleContent,
  messageMarksSetupDone,
} from "./richMessageContent.js";

const ENVELOPE = '{"v":1,"blocks":[{"kind":"setupDone"}]}';

describe("extractRichContentFromBody, unlabelled envelopes", () => {
  it("lifts a fence with no language", () => {
    const got = extractRichContentFromBody(`All set.\n\n\`\`\`\n${ENVELOPE}\n\`\`\``);
    expect(got.rich?.blocks[0]?.kind).toBe("setupDone");
    expect(got.text).toBe("All set.");
  });

  it("lifts a fence labelled json", () => {
    const got = extractRichContentFromBody(`All set.\n\n\`\`\`json\n${ENVELOPE}\n\`\`\``);
    expect(got.rich?.blocks[0]?.kind).toBe("setupDone");
    expect(got.text).toBe("All set.");
  });

  it("lifts a bare line of JSON", () => {
    const got = extractRichContentFromBody(`All set.\n\n${ENVELOPE}`);
    expect(got.rich?.blocks[0]?.kind).toBe("setupDone");
    expect(got.text).toBe("All set.");
  });

  it("still prefers the labelled fence", () => {
    const got = extractRichContentFromBody(`Done.\n\n\`\`\`hq-block\n${ENVELOPE}\n\`\`\``);
    expect(got.rich?.blocks[0]?.kind).toBe("setupDone");
    expect(got.text).toBe("Done.");
  });

  it("leaves ordinary JSON in the message alone", () => {
    const body = 'Here is the config:\n\n```json\n{"port":3000}\n```';
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });

  it("marks setup done from an unlabelled fence", () => {
    expect(messageMarksSetupDone({ body: `All set.\n\n\`\`\`\n${ENVELOPE}\n\`\`\`` })).toBe(true);
  });
});

describe("the marker never survives as text", () => {
  const shapes: Array<[string, string]> = [
    ["indented fence", "All set.\n\n    ```hq-block\n    " + ENVELOPE + "\n    ```"],
    ["pretty printed", 'All set.\n\n```\n{\n  "v": 1,\n  "blocks": [\n    { "kind": "setupDone" }\n  ]\n}\n```'],
    ["tilde fence", "All set.\n\n~~~\n" + ENVELOPE + "\n~~~"],
    ["no trailing newline", "All set.\n" + ENVELOPE],
    ["inline on its own", ENVELOPE],
  ];
  for (const [name, body] of shapes) {
    it(`strips it: ${name}`, () => {
      const got = extractRichContentFromBody(body);
      expect(got.rich?.blocks[0]?.kind).toBe("setupDone");
      expect(got.text).not.toContain("setupDone");
      expect(got.text).not.toContain("```");
      expect(messageMarksSetupDone({ body })).toBe(true);
    });
  }

  it("leaves a message that only talks about setup alone", () => {
    const body = "I finished setup. Nothing else to do.";
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });
});

describe("extractRichContentFromBody, several envelopes in one body", () => {
  // Live walkthrough 2026-10-03: the hello carried a suggestions fence and
  // then a connect fence. Only the first was lifted; the second rendered as
  // a code block of JSON under the message.
  const SUGGESTIONS = '{"v":1,"blocks":[{"kind":"suggestions","items":["Summarize our files","List our projects"]}]}';
  const CONNECT = '{"v":1,"blocks":[{"kind":"connect","items":[{"app":"slack"},{"domain":"linear.app"}]}]}';
  const fenced = (json: string): string => "```hq-block\n" + json + "\n```";

  it("lifts two fences, merges their blocks in document order, and leaves no JSON in the text", () => {
    const got = extractRichContentFromBody(`Hi Stefan.\n\n${fenced(SUGGESTIONS)}\n${fenced(CONNECT)}`);
    expect(got.text).toBe("Hi Stefan.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
    expect(got.rich?.blocks[1]).toEqual({ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] });
  });

  it("lifts one fenced envelope and one bare envelope", () => {
    const got = extractRichContentFromBody(`Hi Stefan.\n\n${fenced(SUGGESTIONS)}\n\n${CONNECT}`);
    expect(got.text).toBe("Hi Stefan.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
    expect(got.text).not.toContain("{");
  });

  it("leaves a JSON object that is not an envelope alone, next to one that is", () => {
    const config = '```json\n{"port":3000,"blocks":"none"}\n```';
    const got = extractRichContentFromBody(`Here is the config:\n\n${config}\n\n${fenced(CONNECT)}`);
    expect(got.text).toBe(`Here is the config:\n\n${config}`);
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
  });

  it("lifts an envelope between two paragraphs of prose and joins the prose with one blank line", () => {
    const got = extractRichContentFromBody(`First paragraph.\n\n${fenced(SUGGESTIONS)}\n\nSecond paragraph.\n\n${fenced(CONNECT)}`);
    expect(got.text).toBe("First paragraph.\n\nSecond paragraph.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
  });

  it("still cuts an envelope of unknown blocks next to a known one", () => {
    const newer = '{"v":1,"blocks":[{"kind":"hologram","depth":3}]}';
    const got = extractRichContentFromBody(`Look.\n\n${fenced(CONNECT)}\n\n${fenced(newer)}`);
    expect(got.text).toBe("Look.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
  });
});

describe("messageHasVisibleContent", () => {
  it("is false for a message that is only the marker", () => {
    expect(messageHasVisibleContent({ body: ENVELOPE })).toBe(false);
  });

  it("is true when the marker rides along with real words", () => {
    expect(messageHasVisibleContent({ body: `All set.\n\n${ENVELOPE}` })).toBe(true);
  });

  it("is true for an ordinary message", () => {
    expect(messageHasVisibleContent({ body: "hello" })).toBe(true);
  });
});
