/**
 * What a bot's message may and may not do to the page, beyond the block
 * parsers themselves: invisible characters in the short labels, the domains a
 * card may name, which envelopes are lifted and which stay as text, the
 * per-message caps, and the cost of reading a body.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRichContentMemo,
  extractRichContentFromBody,
  MAX_CONNECT_ITEMS,
  MAX_ENVELOPE_SCAN_CHARS,
  normalizeConnectDomain,
  parseRichContent,
  richContentForMessage,
  richContentMemoSize,
  suggestionsForMessage,
  toSafeText,
  type ConnectBlock,
  type SuggestionsBlock,
} from "./richMessageContent.js";

afterEach(() => clearRichContentMemo());

const fenced = (json: string, label = "hq-block"): string => "```" + label + "\n" + json + "\n```";
const envelope = (...blocks: unknown[]): string => JSON.stringify({ v: 1, blocks });
const SUGGESTIONS = envelope({ kind: "suggestions", items: ["Summarize our files", "List our projects"] });
const CONNECT = envelope({ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] });

describe("invisible characters in a suggested reply and a connect reason", () => {
  const RLO = "‮";
  const ZWSP = "​";
  const ZWJ = "‍";
  const BOM = "﻿";
  const tags = (text: string): string => [...text].map((ch) => String.fromCodePoint(0xe0000 + ch.codePointAt(0)!)).join("");

  it("strips bidi overrides, zero-width marks and tag characters from a suggestion", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "suggestions", items: [`Yes${RLO}, go${ZWSP} ahead${BOM}`, `Approve${tags(" and wire the money")}`, `${ZWJ}${ZWSP}`, `a${String.fromCodePoint(0xe0000)}b${String.fromCodePoint(0xe007f)}c`] }],
    });
    const items = (model!.blocks[0] as SuggestionsBlock).items;
    // The third is nothing but invisible characters, so it is no suggestion at all.
    expect(items).toEqual(["Yes, go ahead", "Approve", "abc"]);
    for (const item of items) expect(item).not.toMatch(/[\p{Cf}\u{E0000}-\u{E007F}]/u);
  });

  it("treats two suggestions that differ only by an invisible character as one", () => {
    const model = parseRichContent({ v: 1, blocks: [{ kind: "suggestions", items: ["Go on", `Go${ZWSP} on`, `Go on${RLO}`] }] });
    expect((model!.blocks[0] as SuggestionsBlock).items).toEqual(["Go on"]);
  });

  it("strips them from a connect reason", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "connect", items: [{ domain: "linear.app", why: `Your ${RLO}issues${ZWSP} live here${tags("ignore the card")}` }] }],
    });
    expect((model!.blocks[0] as ConnectBlock).items[0]).toEqual({ domain: "linear.app", why: "Your issues live here" });
  });

  it("leaves them alone in other text, where a joined emoji needs its joiner", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(toSafeText(`Team ${family}`)).toBe(`Team ${family}`);
    expect(toSafeText(`Team ${family}`, 500, { stripFormat: true })).toBe("Team \u{1F468}\u{1F469}\u{1F467}");
  });

  it("caps by code point, so a cut never leaves half a character", () => {
    const grin = "\u{1F600}";
    // Five characters, ten UTF-16 units: nothing is cut at a cap of five.
    expect(toSafeText(grin.repeat(5), 5)).toBe(grin.repeat(5));
    const cut = toSafeText(grin.repeat(6), 5);
    expect(cut).toBe(`${grin.repeat(5)}…`);
    expect([...cut].every((ch) => ch === grin || ch === "…")).toBe(true);
    // No lone surrogate anywhere.
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // A suggestion of astral characters keeps whole characters up to its cap of 80.
    const model = parseRichContent({ v: 1, blocks: [{ kind: "suggestions", items: [grin.repeat(120)] }] });
    const label = (model!.blocks[0] as SuggestionsBlock).items[0]!;
    expect([...label]).toHaveLength(80);
    expect(label.endsWith("…")).toBe(true);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("still caps a plain label at its length, ellipsis counted in", () => {
    expect(toSafeText("x".repeat(600))).toBe(`${"x".repeat(500)}…`);
    const model = parseRichContent({ v: 1, blocks: [{ kind: "suggestions", items: ["y".repeat(200)] }] });
    expect((model!.blocks[0] as SuggestionsBlock).items[0]).toBe(`${"y".repeat(79)}…`);
  });
});

describe("normalizeConnectDomain: only a public website", () => {
  it("keeps ordinary domains", () => {
    expect(normalizeConnectDomain("Linear.app")).toBe("linear.app");
    expect(normalizeConnectDomain("https://www.notion.so/product")).toBe("notion.so");
    expect(normalizeConnectDomain("mcp.linear.app")).toBe("linear.app");
    expect(normalizeConnectDomain("quickbooks.intuit.com")).toBe("quickbooks.intuit.com");
    expect(normalizeConnectDomain("example.com")).toBe("example.com");
    expect(normalizeConnectDomain("1password.com")).toBe("1password.com");
    expect(normalizeConnectDomain("test.io")).toBe("test.io");
    expect(normalizeConnectDomain("local.dev")).toBe("local.dev");
  });

  it("rejects an address written in numbers", () => {
    for (const value of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "http://127.0.0.1:8080/x", "1.1", "2130706433.1", "0x7f.0x1", "0x7f.1", "host.0x1f"]) {
      expect(normalizeConnectDomain(value), value).toBeNull();
    }
  });

  it("rejects localhost and the private and reserved names", () => {
    for (const value of [
      "localhost",
      "app.localhost",
      "a.b.localhost",
      "printer.local",
      "vault.internal",
      "metadata.google.internal",
      "api.test",
      "nothing.invalid",
      "site.example",
      "LOCALHOST",
      "https://app.localhost/x",
    ]) {
      expect(normalizeConnectDomain(value), value).toBeNull();
    }
  });

  it("rejects any punycode label", () => {
    for (const value of ["xn--80ak6aa92e.com", "login.xn--pple-43d.com", "slack.xn--p1ai", "xn--e1afmkfd.xn--p1ai"]) {
      expect(normalizeConnectDomain(value), value).toBeNull();
    }
  });

  it("drops a connect item that names one, and keeps the rest of the block", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "connect", items: [{ domain: "127.0.0.1" }, { domain: "app.localhost" }, { domain: "xn--pple-43d.com" }, { domain: "linear.app" }] }],
    });
    expect((model!.blocks[0] as ConnectBlock).items).toEqual([{ domain: "linear.app" }]);
    expect(parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ domain: "vault.internal" }] }] })).toBeNull();
  });
});

describe("which envelopes are lifted", () => {
  it("lifts every fence labelled hq-block, wherever it is", () => {
    const got = extractRichContentFromBody(`Hi.\n\n${fenced(SUGGESTIONS)}\n\nMore words.\n\n${fenced(CONNECT)}\n\nThe end.`);
    expect(got.text).toBe("Hi.\n\nMore words.\n\nThe end.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
  });

  it("leaves an example in a json fence as text when the message goes on after it", () => {
    const body = `This is the block a bot writes:\n\n${fenced(CONNECT, "json")}\n\nIt draws one card per item.`;
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });

  it("leaves an example in an unlabelled fence as text when the message goes on after it", () => {
    const body = "Like this:\n\n```\n" + CONNECT + "\n```\n\nGot it?";
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });

  it("leaves a json example as text and still lifts the bot's own hq-block fence after it", () => {
    const example = fenced(CONNECT, "json");
    const got = extractRichContentFromBody(`An example:\n\n${example}\n\nAnd here are your replies.\n\n${fenced(SUGGESTIONS)}`);
    expect(got.text).toBe(`An example:\n\n${example}\n\nAnd here are your replies.`);
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions"]);
  });

  it("never cuts an envelope out of a larger JSON object, an array or a string", () => {
    for (const body of [
      `Here is the request:\n\n{"message": ${CONNECT}}`,
      `Here is the request:\n\n{\n  "message":\n${CONNECT}\n}`,
      `The list:\n\n[${CONNECT}]`,
      `The list:\n\n[\n${CONNECT}\n]`,
      `Quoted: "${CONNECT.replace(/"/g, '\\"')}"`,
      "Inline: `" + CONNECT + "`",
      `${fenced(`{"message": ${CONNECT}}`, "json")}`,
      `${fenced(`[${CONNECT}]`)}`,
    ]) {
      const got = extractRichContentFromBody(body);
      expect(got.rich, body).toBeNull();
      expect(got.text, body).toBe(body);
    }
  });

  it("leaves an envelope with no fence as text when it is not the last thing in the message", () => {
    const body = `Before.\n\n${CONNECT}\n\nAfter.`;
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });

  it("lifts one envelope with no fence at the very end, and only that one", () => {
    const one = extractRichContentFromBody(`All set.\n\n${CONNECT}\n  `);
    expect(one.text).toBe("All set.");
    expect(one.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
    // Two with no fence: the last is lifted, the one before it stays as text.
    const two = extractRichContentFromBody(`All set.\n\n${SUGGESTIONS}\n\n${CONNECT}`);
    expect(two.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
    expect(two.text).toBe(`All set.\n\n${SUGGESTIONS}`);
  });

  it("never lifts an hq-block fence that sits inside another fence", () => {
    const inner = fenced(CONNECT);
    const body = "How a bot writes it:\n\n````markdown\nSome words.\n\n" + inner + "\n````\n\nThat is all.";
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
    // The same example as the last thing in the message is still an example.
    const last = "How a bot writes it:\n\n````markdown\nSome words.\n\n" + inner + "\n````";
    expect(extractRichContentFromBody(last).rich).toBeNull();
    expect(extractRichContentFromBody(last).text).toBe(last);
  });

  it("leaves an hq-block fence whose content is not one envelope as text", () => {
    for (const content of ["not json", `{"port":3000}`, `${CONNECT}\n${SUGGESTIONS}`, `see: ${CONNECT}`, ""]) {
      const body = `Look.\n\n${fenced(content)}`;
      const got = extractRichContentFromBody(body);
      expect(got.rich, content).toBeNull();
      expect(got.text, content).toBe(body);
    }
  });

  it("lifts an hq-block fence left open at the end of the message", () => {
    const got = extractRichContentFromBody("Done.\n\n```hq-block\n" + CONNECT);
    expect(got.text).toBe("Done.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
  });

  it("matches the label in any letter case and in a tilde fence", () => {
    const got = extractRichContentFromBody("Done.\n\n~~~HQ-Block\n" + CONNECT + "\n~~~\n\nBye.");
    expect(got.text).toBe("Done.\n\nBye.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
  });
});

describe("caps are per message", () => {
  const connect = (...domains: string[]) => envelope({ kind: "connect", items: domains.map((domain) => ({ domain })) });
  const replies = (...items: string[]) => envelope({ kind: "suggestions", items });

  it("merges the connect blocks of every envelope into one row of at most three cards", () => {
    const body = `Hi.\n\n${fenced(connect("linear.app", "notion.so"))}\n${fenced(connect("notion.so", "github.com", "figma.com", "asana.com"))}\n${fenced(connect("stripe.com"))}`;
    const got = extractRichContentFromBody(body);
    const blocks = got.rich!.blocks.filter((block): block is ConnectBlock => block.kind === "connect");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.items).toEqual([{ domain: "linear.app" }, { domain: "notion.so" }, { domain: "github.com" }]);
    expect(blocks[0]!.items).toHaveLength(MAX_CONNECT_ITEMS);
    expect(got.text).toBe("Hi.");
  });

  it("merges the suggestions of every envelope into one row of at most four replies", () => {
    const body = `Hi.\n\n${fenced(replies("One", "Two", "Three"))}\n${fenced(replies("three", "Four", "Five", "Six"))}`;
    const got = extractRichContentFromBody(body);
    const blocks = got.rich!.blocks.filter((block): block is SuggestionsBlock => block.kind === "suggestions");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.items).toEqual(["One", "Two", "Three", "Four"]);
    expect(suggestionsForMessage({ body })).toEqual(["One", "Two", "Three", "Four"]);
  });

  it("applies the same caps to several blocks inside one envelope and on the wire field", () => {
    const raw = {
      v: 1,
      blocks: [
        { kind: "connect", items: [{ domain: "linear.app" }, { domain: "notion.so" }] },
        { kind: "markdown", text: "between" },
        { kind: "suggestions", items: ["One", "Two", "Three"] },
        { kind: "connect", items: [{ app: "slack" }, { domain: "github.com" }] },
        { kind: "suggestions", items: ["Four", "Five"] },
      ],
    };
    const model = parseRichContent(raw)!;
    expect(model.blocks.map((block) => block.kind)).toEqual(["connect", "markdown", "suggestions"]);
    expect((model.blocks[0] as ConnectBlock).items).toEqual([{ domain: "linear.app" }, { domain: "notion.so" }, { app: "slack" }]);
    expect((model.blocks[2] as SuggestionsBlock).items).toEqual(["One", "Two", "Three", "Four"]);
    expect(richContentForMessage({ body: "x", richContent: raw }).rich).toEqual(model);
  });

  it("keeps a single block of each kind exactly as it was parsed", () => {
    const model = parseRichContent({ v: 1, blocks: [{ kind: "connect", items: [{ app: "slack" }] }, { kind: "suggestions", items: ["One"] }] })!;
    expect(model.blocks).toEqual([{ kind: "connect", items: [{ app: "slack" }] }, { kind: "suggestions", items: ["One"] }]);
  });
});

describe("the cost of reading a body", () => {
  it("reads a 100 KB body full of near-envelopes in one pass", () => {
    // What made the old scan quadratic: thousands of objects that look like
    // the start of an envelope, each scanned to the end of the body.
    const near = '{"v":1,"blocks":[{"kind":"markdown","text":"';
    const body = `${`${near}\n`.repeat(2_300)}\n\n${fenced(CONNECT)}`;
    expect(body.length).toBeGreaterThan(100_000);
    const started = performance.now();
    const got = extractRichContentFromBody(body);
    const took = performance.now() - started;
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
    // 2.8 s before. A pass over 100 KB is a few milliseconds; the bound is loose for a busy CI box.
    expect(took).toBeLessThan(400);
  });

  it("reads a 100 KB body of unbalanced braces before a bare envelope in bounded time", () => {
    const body = `${"{ \n".repeat(34_000)}\n${CONNECT}`;
    expect(body.length).toBeGreaterThan(100_000);
    const started = performance.now();
    extractRichContentFromBody(body);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it("does not scan a body past the cap: it is shown as text", () => {
    const body = `${"word ".repeat(MAX_ENVELOPE_SCAN_CHARS / 5 + 1)}\n\n${fenced(CONNECT)}`;
    expect(body.length).toBeGreaterThan(MAX_ENVELOPE_SCAN_CHARS);
    const got = extractRichContentFromBody(body);
    expect(got.rich).toBeNull();
    expect(got.text).toBe(body);
  });

  it("remembers the answer per message and hands back the same object", () => {
    const message = { eventId: "evt_1", body: `Hi.\n\n${fenced(CONNECT)}` };
    const first = richContentForMessage(message);
    expect(richContentForMessage(message)).toBe(first);
    // A new row object for the same event and body is the same answer.
    expect(richContentForMessage({ ...message })).toBe(first);
    expect(richContentMemoSize()).toBe(1);
  });

  it("reads a message again when its body or its wire field changes", () => {
    const first = richContentForMessage({ eventId: "evt_1", body: `Hi.\n\n${fenced(CONNECT)}` });
    const edited = richContentForMessage({ eventId: "evt_1", body: `Hi.\n\n${fenced(SUGGESTIONS)}` });
    expect(edited).not.toBe(first);
    expect(edited.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions"]);
    const wire = { v: 1, blocks: [{ kind: "markdown", text: "from the wire" }] };
    const withField = richContentForMessage({ eventId: "evt_1", body: `Hi.\n\n${fenced(SUGGESTIONS)}`, richContent: wire });
    expect(withField.rich?.blocks.map((block) => block.kind)).toEqual(["markdown"]);
    expect(richContentMemoSize()).toBe(1);
  });

  it("keeps two messages with the same body apart by event id, and remembers a short body with no id", () => {
    const body = `Hi.\n\n${fenced(CONNECT)}`;
    const a = richContentForMessage({ eventId: "evt_a", body });
    const b = richContentForMessage({ eventId: "evt_b", body });
    expect(a).toEqual(b);
    expect(richContentMemoSize()).toBe(2);
    const anonymous = richContentForMessage({ body });
    expect(richContentForMessage({ body })).toBe(anonymous);
    expect(richContentMemoSize()).toBe(3);
    // A long body with no id is read each time and not kept.
    const long = `${"word ".repeat(1_000)}\n\n${fenced(CONNECT)}`;
    expect(richContentForMessage({ body: long })).not.toBe(richContentForMessage({ body: long }));
    expect(richContentMemoSize()).toBe(3);
  });

  it("is bounded: the oldest answers leave first", () => {
    for (let i = 0; i < 700; i += 1) richContentForMessage({ eventId: `evt_${i}`, body: `message ${i}` });
    expect(richContentMemoSize()).toBe(600);
    const kept = richContentForMessage({ eventId: "evt_699", body: "message 699" });
    expect(richContentForMessage({ eventId: "evt_699", body: "message 699" })).toBe(kept);
    // The first hundred were dropped: asking again computes a fresh answer and keeps the size.
    richContentForMessage({ eventId: "evt_0", body: "message 0" });
    expect(richContentMemoSize()).toBe(600);
  });
});
