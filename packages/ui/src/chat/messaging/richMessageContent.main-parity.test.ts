/**
 * Parity with origin/main for every block kind main already drew.
 *
 * This release goes to every user, including bots on older runtimes, which
 * write the envelope in every shape: an `hq-block` fence, a `json` fence, a
 * fence with no label, a bare line, in the middle of a message or at its end.
 * Whatever main lifted and drew for the kinds it knows must be lifted and
 * drawn the same way now.
 *
 * `mainExtract` below is main's own extraction, copied from
 * origin/main (74a2654b1) `richMessageContent.ts`: `jsonObjectEnd`,
 * `withSurroundingFence`, `isUnknownEnvelope`, `findEnvelopeSpan` and
 * `extractRichContentFromBody`, unchanged but for their names. It is the
 * reference each case is compared with. Main does not know the `connect`
 * kind, so the reference drops it from what the block parser returns.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRichContentMemo,
  extractRichContentFromBody,
  messageHasConnectBlock,
  messageHasVisibleContent,
  messageMarksSetupDone,
  messageOffersSlackAgent,
  parseRichContent,
  richContentForMessage,
  suggestionsForMessage,
  type ConnectBlock,
  type ExtractedRichContent,
  type RichContentModel,
} from "./richMessageContent.js";

afterEach(() => clearRichContentMemo());

// ── main's extraction, as the reference ──────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The block parser as main has it: the same parser, minus the kind main does not know. */
function mainParseRichContent(raw: unknown): RichContentModel | null {
  const model = parseRichContent(raw);
  if (!model) return null;
  const blocks = model.blocks.filter((block) => block.kind !== "connect");
  return blocks.length > 0 ? { blocks } : null;
}

function mainJsonObjectEnd(body: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function mainWithSurroundingFence(body: string, start: number, end: number): [number, number] {
  const before = body.slice(0, start);
  const openFence = /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*[A-Za-z0-9_-]*[ \t]*\n[ \t]*$/.exec(before);
  if (!openFence) return [start, end];
  const rest = body.slice(end);
  const closeFence = new RegExp("^[ \\t]*\\n?[ \\t]*" + openFence[2] + "[ \\t]*").exec(rest);
  if (!closeFence) return [start, end];
  return [start - (openFence[0].length - openFence[1].length), end + closeFence[0].length];
}

function mainIsUnknownEnvelope(raw: unknown): boolean {
  if (!isRecord(raw) || raw.v !== 1 || !Array.isArray(raw.blocks)) return false;
  return raw.blocks.length > 0 && raw.blocks.every((b) => isRecord(b) && typeof b.kind === "string");
}

function mainFindEnvelopeSpan(body: string): { start: number; end: number; rich: RichContentModel | null } | null {
  if (!body.includes('"blocks"')) return null;
  for (let i = body.indexOf("{"); i !== -1; i = body.indexOf("{", i + 1)) {
    const head = body.slice(i, i + 64);
    if (!head.includes('"v"') && !head.includes('"blocks"')) continue;
    const end = mainJsonObjectEnd(body, i);
    if (end === -1) continue;
    let raw: unknown = null;
    try {
      raw = JSON.parse(body.slice(i, end));
    } catch {
      continue;
    }
    const rich = mainParseRichContent(raw);
    if (!rich && !mainIsUnknownEnvelope(raw)) continue;
    const [from, to] = mainWithSurroundingFence(body, i, end);
    return { start: from, end: to, rich };
  }
  return null;
}

function mainExtract(body: string): ExtractedRichContent {
  if (!body) return { text: "", rich: null };
  const span = mainFindEnvelopeSpan(body);
  if (!span) return { text: body, rich: null };
  const text = (body.slice(0, span.start) + body.slice(span.end)).replace(/\n{3,}/g, "\n\n").trim();
  return { text, rich: span.rich };
}

// ── The cases ────────────────────────────────────────────────────────────

const env = (...blocks: unknown[]): string => JSON.stringify({ v: 1, blocks });
const pretty = (json: string): string => JSON.stringify(JSON.parse(json), null, 2);

const TABLE = { kind: "table", columns: ["Plan", "Seats"], rows: [["Team", "12"], ["Solo", "1"]], caption: "Plans" };
const CHART = { kind: "chart", chartType: "bar", series: [{ name: "Signups", data: [3, 5, 8] }], categories: ["Mon", "Tue", "Wed"] };
const DECISION = { kind: "decision", question: "Ship it?", options: [{ id: "y", label: "Yes", recommended: true }, { id: "n", label: "No" }], questionId: "q_1" };
const CONNECT = { kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] };

/** Every kind main draws, one envelope each, plus the shapes main treats specially. */
const MAIN_KINDS: Record<string, string> = {
  "the finish marker": env({ kind: "setupDone" }),
  "the finish marker with the Slack offer": env({ kind: "setupDone", slackAgent: true }),
  table: env(TABLE),
  chart: env(CHART),
  decision: env(DECISION),
  stat: env({ kind: "stat", items: [{ label: "Revenue", value: "$1.2M", delta: "+12%", trend: "up" }] }),
  markdown: env({ kind: "markdown", text: "**Done.** See the table." }),
  badge: env({ kind: "badge", label: "Live", tone: "success" }),
  keyValue: env({ kind: "keyValue", items: [{ key: "Owner", value: "Sam" }] }),
  progress: env({ kind: "progress", label: "Import", value: 40 }),
  callout: env({ kind: "callout", tone: "warning", title: "Heads up", body: "The key expires soon." }),
  "suggested replies": env({ kind: "suggestions", items: ["Summarize our files", "List our projects"] }),
  "a table and a chart": env(TABLE, CHART),
  "an envelope with no version": JSON.stringify({ blocks: [TABLE] }),
  'an envelope with version "1"': JSON.stringify({ v: "1", blocks: [TABLE] }),
  "an envelope of a kind nobody knows yet": env({ kind: "hologram", depth: 3 }),
  "an envelope of another version": JSON.stringify({ v: 2, blocks: [TABLE] }),
  "JSON that is not an envelope": JSON.stringify({ port: 3000, blocks: "none" }),
};

/** Envelopes that carry the kind new in this release. */
const CONNECT_KINDS: Record<string, string> = {
  "a connect block": env(CONNECT),
  "a connect block and a table": env(CONNECT, TABLE),
  "a connect block with no version": JSON.stringify({ blocks: [CONNECT] }),
};

const fence = (json: string, label = "", mark = "```"): string => `${mark}${label}\n${json}\n${mark}`;

/** Places a bot writes its own envelope on purpose: where a `connect` block is kept. */
const STRICT_PLACES: Record<string, (json: string) => string> = {
  "an hq-block fence at the end": (j) => `All set.\n\n${fence(j, "hq-block")}`,
  "an hq-block fence with more text after it": (j) => `Here you go.\n\n${fence(j, "hq-block")}\n\nTell me what you think.`,
  "an hq-block tilde fence": (j) => `All set.\n\n${fence(j, "hq-block", "~~~")}\n\nBye.`,
  "an indented hq-block fence": (j) => `All set.\n\n    \`\`\`hq-block\n    ${j}\n    \`\`\``,
  "a pretty-printed hq-block fence": (j) => `All set.\n\n${fence(pretty(j), "hq-block")}\n\nBye.`,
  "a json fence as the last thing": (j) => `All set.\n\n${fence(j, "json")}`,
  "a fence with no label as the last thing": (j) => `All set.\n\n${fence(j)}\n`,
  "a bare line as the last thing": (j) => `All set.\n\n${j}`,
  "a bare line with no newline before it": (j) => `All set.\n${j}  `,
  "pretty-printed and bare as the last thing": (j) => `All set.\n\n${pretty(j)}`,
  "the whole message": (j) => j,
};

/** Places only the open scan reaches: an old kind is lifted here as on main, a `connect` block is not. */
const LOOSE_PLACES: Record<string, (json: string) => string> = {
  "a json fence with more text after it": (j) => `Here is the read.\n\n${fence(j, "json")}\n\nTell me what you think.`,
  "a fence with no label with more text after it": (j) => `Here is the read.\n\n${fence(j)}\n\nTell me what you think.`,
  "a tilde fence with more text after it": (j) => `Here is the read.\n\n${fence(j, "", "~~~")}\n\nMore.`,
  "a pretty-printed json fence with more text after it": (j) => `Here is the read.\n\n${fence(pretty(j), "json")}\n\nMore.`,
  "a bare line with more text after it": (j) => `Here is the read.\n\n${j}\n\nTell me what you think.`,
  "pretty-printed and bare with more text after it": (j) => `Here is the read.\n\n${pretty(j)}\n\nMore.`,
  "the first thing in the message": (j) => `${j}\n\nThat is the read.`,
  "the middle of a sentence": (j) => `I sent ${j} a moment ago.`,
  "inside a larger JSON object": (j) => `The request was:\n\n{"message": ${j}, "to": "you"}`,
  "inside an array": (j) => `The list:\n\n[${j}]`,
  "inside inline code": (j) => `Inline: \`${j}\` done.`,
  "an hq-block fence inside another fence": (j) => `How a bot writes it:\n\n\`\`\`\`markdown\nSome words.\n\n${fence(j, "hq-block")}\n\`\`\`\`\n\nThat is all.`,
  "an hq-block fence holding more than the envelope": (j) => `Look.\n\n${fence(`see: ${j}`, "hq-block")}\n\nBye.`,
};

describe("parity with main: every kind main draws, in every place main found it", () => {
  for (const [kind, json] of Object.entries(MAIN_KINDS)) {
    for (const [place, wrap] of Object.entries({ ...STRICT_PLACES, ...LOOSE_PLACES })) {
      it(`${kind}, in ${place}`, () => {
        const body = wrap(json);
        const expected = mainExtract(body);
        expect(extractRichContentFromBody(body)).toEqual(expected);
        // The same through the call the conversation makes, and what the host reads off it.
        const message = { eventId: "evt_1", body };
        expect(richContentForMessage(message)).toEqual(expected);
        expect(messageMarksSetupDone(message)).toBe(expected.rich?.blocks.some((b) => b.kind === "setupDone") ?? false);
        expect(messageHasConnectBlock(message)).toBe(false);
      });
    }
  }

  it("covers cases main really lifts: this is not a table of nulls", () => {
    let lifted = 0;
    let total = 0;
    for (const json of Object.values(MAIN_KINDS)) {
      for (const wrap of Object.values({ ...STRICT_PLACES, ...LOOSE_PLACES })) {
        total += 1;
        if (mainExtract(wrap(json)).rich) lifted += 1;
      }
    }
    expect(total).toBe(18 * 24);
    // Fifteen of the eighteen shapes carry a block main draws, in all twenty-four places.
    expect(lifted).toBe(15 * 24);
  });
});

describe("parity with main: the cases the re-review named", () => {
  it("an envelope in a json fence followed by more text is lifted and cut, for a table, a chart and a decision", () => {
    for (const block of [TABLE, CHART, DECISION]) {
      const body = `Here is the read.\n\n${fence(env(block), "json")}\n\nTell me what you think.`;
      const got = extractRichContentFromBody(body);
      expect(got.rich?.blocks.map((b) => b.kind)).toEqual([block.kind]);
      expect(got.text).toBe("Here is the read.\n\nTell me what you think.");
      expect(got).toEqual(mainExtract(body));
    }
  });

  it("a bare envelope followed by more text is lifted and cut", () => {
    const body = `Here is the read.\n\n${env(TABLE)}\n\nTell me what you think.`;
    const got = extractRichContentFromBody(body);
    expect(got.rich?.blocks.map((b) => b.kind)).toEqual(["table"]);
    expect(got.text).toBe("Here is the read.\n\nTell me what you think.");
    expect(got.text).not.toContain("{");
    expect(got).toEqual(mainExtract(body));
  });

  it("a finish marker in the middle of a message still ends setup, in every loose shape", () => {
    const marker = env({ kind: "setupDone", slackAgent: true });
    for (const body of [
      `All set.\n\n${fence(marker, "json")}\n\nOne more thing: say hi any time.`,
      `All set.\n\n${fence(marker)}\n\nOne more thing: say hi any time.`,
      `All set.\n\n${marker}\n\nOne more thing: say hi any time.`,
      `All set. ${marker} One more thing: say hi any time.`,
    ]) {
      const message = { body };
      expect(messageMarksSetupDone(message), body).toBe(true);
      expect(messageOffersSlackAgent(message), body).toBe(true);
      expect(messageHasVisibleContent(message)).toBe(true);
      const got = extractRichContentFromBody(body);
      expect(got.text).not.toContain("setupDone");
      expect(got.text).not.toContain("```");
      expect(got).toEqual(mainExtract(body));
    }
  });

  it("two envelopes in one message: the first is main's, and the second is lifted too where main left it as JSON", () => {
    const shapes: Array<[string, string]> = [
      [fence(env(TABLE), "json"), fence(env(CHART), "json")],
      [fence(env(TABLE), "hq-block"), env(CHART)],
      [env(TABLE), fence(env(CHART))],
      [fence(env(DECISION), "hq-block"), fence(env({ kind: "suggestions", items: ["Yes", "No"] }), "hq-block")],
    ];
    for (const [first, second] of shapes) {
      const body = `One.\n\n${first}\n\nTwo.\n\n${second}\n\nThree.`;
      const main = mainExtract(body);
      const got = extractRichContentFromBody(body);
      // Main lifted the first and showed the second as a block of JSON.
      expect(main.rich?.blocks).toHaveLength(1);
      expect(main.text).toContain('"blocks"');
      // The first is read exactly as main read it; the second follows it, and no JSON is left.
      expect(got.rich?.blocks[0]).toEqual(main.rich?.blocks[0]);
      expect(got.rich?.blocks).toHaveLength(2);
      expect(got.text).toBe("One.\n\nTwo.\n\nThree.");
    }
  });

  it("suggested replies in a loose place are still offered, as on main", () => {
    const body = `Pick one.\n\n${fence(env({ kind: "suggestions", items: ["Summarize our files", "List our projects"] }), "json")}\n\nOr ask me anything.`;
    expect(suggestionsForMessage({ body })).toEqual(["Summarize our files", "List our projects"]);
    expect(extractRichContentFromBody(body)).toEqual(mainExtract(body));
  });

  it("an explicit wire field still wins over anything in the body, as on main", () => {
    const body = `Text.\n\n${fence(env(TABLE), "json")}\n\nMore.`;
    const got = richContentForMessage({ body, richContent: { v: 1, blocks: [CHART] } });
    expect(got.text).toBe(body);
    expect(got.rich?.blocks.map((b) => b.kind)).toEqual(["chart"]);
  });
});

describe("the one kind new in this release: connect is kept only from a strict place", () => {
  const cardsOf = (got: ExtractedRichContent): ConnectBlock["items"] =>
    (got.rich?.blocks ?? []).flatMap((b) => (b.kind === "connect" ? b.items : []));

  for (const [place, wrap] of Object.entries(STRICT_PLACES)) {
    it(`keeps a connect block in ${place}`, () => {
      const got = extractRichContentFromBody(wrap(CONNECT_KINDS["a connect block"]!));
      expect(cardsOf(got)).toEqual([{ app: "slack" }, { domain: "linear.app" }]);
      expect(got.text).not.toContain('"connect"');
      expect(got.text).not.toContain("```");
      // With a table next to it, the table is main's and the cards come with it.
      const both = wrap(CONNECT_KINDS["a connect block and a table"]!);
      const mixed = extractRichContentFromBody(both);
      expect(mixed.rich?.blocks.map((b) => b.kind)).toEqual(["connect", "table"]);
      expect(mixed.text).toBe(mainExtract(both).text);
    });
  }

  for (const [place, wrap] of Object.entries(LOOSE_PLACES)) {
    it(`drops a connect block in ${place}, and leaves the text as main left it`, () => {
      for (const [kind, json] of Object.entries(CONNECT_KINDS)) {
        const body = wrap(json);
        const got = extractRichContentFromBody(body);
        expect(cardsOf(got), kind).toEqual([]);
        expect(messageHasConnectBlock({ body }), kind).toBe(false);
        // Main did not know `connect`: what it lifted and what it cut is what happens here.
        expect(got, kind).toEqual(mainExtract(body));
      }
    });
  }

  it("keeps only the last of two envelopes written with no fence", () => {
    const first = env({ kind: "connect", items: [{ domain: "notion.so" }] });
    const last = env({ kind: "connect", items: [{ domain: "linear.app" }] });
    const got = extractRichContentFromBody(`Two offers.\n\n${first}\n\n${last}`);
    expect(cardsOf(got)).toEqual([{ domain: "linear.app" }]);
  });

  it("keeps a connect example out of the cards and still lifts the bot's own hq-block fence after it", () => {
    const example = fence(env(CONNECT), "json");
    const own = fence(env({ kind: "connect", items: [{ domain: "notion.so" }] }), "hq-block");
    const got = extractRichContentFromBody(`An example:\n\n${example}\n\nAnd the real one.\n\n${own}`);
    expect(cardsOf(got)).toEqual([{ domain: "notion.so" }]);
    expect(got.text).toBe("An example:\n\nAnd the real one.");
  });
});

describe("where main left an empty code fence behind, the fence goes too", () => {
  it("a blank line between the fence and the envelope", () => {
    const body = `All set.\n\n\`\`\`json\n\n${env(TABLE)}\n\n\`\`\`\n\nBye.`;
    const main = mainExtract(body);
    const got = extractRichContentFromBody(body);
    expect(main.text).toContain("```");
    expect(got.rich).toEqual(main.rich);
    expect(got.text).toBe("All set.\n\nBye.");
  });

  it("an hq-block fence left open at the end of the message", () => {
    const body = "Done.\n\n```hq-block\n" + env(TABLE);
    const main = mainExtract(body);
    const got = extractRichContentFromBody(body);
    expect(main.text).toBe("Done.\n\n```hq-block");
    expect(got.rich).toEqual(main.rich);
    expect(got.text).toBe("Done.");
  });
});

describe("a body with CRLF line endings", () => {
  const crlf = (text: string): string => text.replace(/\n/g, "\r\n");

  it("lifts a connect block from an hq-block fence, at the end and in the middle", () => {
    const end = extractRichContentFromBody(crlf(`Hi Stefan.\n\n${fence(env(CONNECT), "hq-block")}`));
    expect(end.rich?.blocks).toEqual([{ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }]);
    expect(end.text).toBe("Hi Stefan.");
    const mid = extractRichContentFromBody(crlf(`Hi Stefan.\n\n${fence(env(CONNECT), "hq-block")}\n\nTell me which.`));
    expect(mid.rich?.blocks.map((b) => b.kind)).toEqual(["connect"]);
    expect(mid.text).not.toContain("```");
    expect(mid.text).not.toContain('"connect"');
    expect(mid.text.split(/\r?\n/).filter(Boolean)).toEqual(["Hi Stefan.", "Tell me which."]);
    expect(messageHasConnectBlock({ body: crlf(`Hi.\n\n${fence(env(CONNECT), "hq-block")}\n`) })).toBe(true);
  });

  it("lifts a table from an hq-block fence, as main does, and leaves no empty fence where main left one", () => {
    for (const body of [
      crlf(`The plans.\n\n${fence(env(TABLE), "hq-block")}`),
      crlf(`The plans.\n\n${fence(env(TABLE), "hq-block")}\n\nPick one.`),
      crlf(`The plans.\n\n${fence(pretty(env(TABLE)), "json")}\n\nPick one.`),
    ]) {
      const main = mainExtract(body);
      const got = extractRichContentFromBody(body);
      // Main found the table in a CRLF body, and left the two fence lines behind.
      expect(main.rich?.blocks.map((b) => b.kind)).toEqual(["table"]);
      expect(main.text).toContain("```");
      expect(got.rich).toEqual(main.rich);
      expect(got.text).not.toContain("```");
      expect(got.text).not.toContain("{");
      expect(got.text.startsWith("The plans.")).toBe(true);
    }
  });

  it("keeps a connect block in a json fence that is the last thing, and two hq-block fences in a row", () => {
    const last = extractRichContentFromBody(crlf(`All set.\n\n${fence(env(CONNECT), "json")}\n`));
    expect(last.rich?.blocks.map((b) => b.kind)).toEqual(["connect"]);
    expect(last.text).toBe("All set.");
    const suggestions = env({ kind: "suggestions", items: ["Summarize our files"] });
    const two = extractRichContentFromBody(crlf(`Hi.\n\n${fence(suggestions, "hq-block")}\n${fence(env(CONNECT), "hq-block")}`));
    expect(two.rich?.blocks.map((b) => b.kind)).toEqual(["suggestions", "connect"]);
    expect(two.text).toBe("Hi.");
  });

  it("still drops a connect block from a loose place", () => {
    const body = crlf(`An example:\n\n${fence(env(CONNECT), "json")}\n\nThat is all.`);
    expect(extractRichContentFromBody(body).rich).toBeNull();
    expect(messageHasConnectBlock({ body })).toBe(false);
  });

  it("joins the prose around a lifted envelope with one blank line", () => {
    const got = extractRichContentFromBody(crlf(`One.\n\n${fence(env(TABLE), "hq-block")}\n\nTwo.`));
    expect(got.text).toBe("One.\n\nTwo.");
  });
});
