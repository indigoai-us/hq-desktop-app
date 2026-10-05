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
  isSlackConnectDomain,
  MAX_CONNECT_ITEMS,
  MAX_ENVELOPE_SCAN_CHARS,
  normalizeConnectDomain,
  parseRichContent,
  replyForSuggestion,
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

describe("Slack by its domain is the bot's own Slack item", () => {
  const items = (...entries: unknown[]) =>
    (parseRichContent({ v: 1, blocks: [{ kind: "connect", items: entries }] })!.blocks[0] as ConnectBlock).items;

  it("reads slack.com, with or without www, a scheme or a path, and any name under it, as the Slack app item", () => {
    for (const domain of [
      "slack.com",
      "Slack.com",
      "www.slack.com",
      "https://slack.com/",
      "https://www.slack.com/intl/en-gb/?ref=x",
      "acme.slack.com",
      "https://app.slack.com/client/T1",
      "mcp.slack.com",
    ]) {
      expect(items({ domain }), domain).toEqual([{ app: "slack" }]);
      expect(isSlackConnectDomain(domain), domain).toBe(true);
    }
  });

  it("keeps the bot's reason on it", () => {
    expect(items({ domain: "slack.com", why: "Where your team talks" })).toEqual([{ app: "slack", why: "Where your team talks" }]);
  });

  it("collapses a block that names Slack both ways into one item, the first one's", () => {
    expect(items({ app: "slack", why: "First" }, { domain: "slack.com", why: "Second" }, { domain: "notion.so" })).toEqual([
      { app: "slack", why: "First" },
      { domain: "notion.so" },
    ]);
    expect(items({ domain: "https://www.slack.com/" }, { app: "slack" }, { domain: "acme.slack.com" })).toEqual([{ app: "slack" }]);
    // And across the blocks and envelopes of one message.
    const body = `Hi.\n\n${fenced(envelope({ kind: "connect", items: [{ domain: "slack.com" }] }))}\n${fenced(envelope({ kind: "connect", items: [{ app: "slack" }, { domain: "linear.app" }] }))}`;
    const blocks = extractRichContentFromBody(body).rich!.blocks.filter((block): block is ConnectBlock => block.kind === "connect");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.items).toEqual([{ app: "slack" }, { domain: "linear.app" }]);
  });

  it("leaves a domain that only resembles Slack's as that other site", () => {
    for (const domain of ["slack.dev", "notslack.com", "slack.com.example.org", "myslack.co", "slack-tools.com"]) {
      expect(items({ domain }), domain).toEqual([{ domain }]);
      expect(isSlackConnectDomain(domain), domain).toBe(false);
    }
    expect(isSlackConnectDomain(null)).toBe(false);
    expect(isSlackConnectDomain("not a domain")).toBe(false);
  });
});

describe("where a connect block is lifted from", () => {
  // Every other kind is lifted wherever main lifted it, and the text is cut
  // as main cut it: richMessageContent.main-parity.test.ts. A `connect`
  // block draws live buttons, so it is kept only from where a bot writes its
  // own envelope on purpose.
  const cards = (got: { rich: { blocks: Array<{ kind: string }> } | null }): number =>
    (got.rich?.blocks ?? []).filter((block) => block.kind === "connect").length;

  it("lifts every fence labelled hq-block, wherever it is", () => {
    const got = extractRichContentFromBody(`Hi.\n\n${fenced(SUGGESTIONS)}\n\nMore words.\n\n${fenced(CONNECT)}\n\nThe end.`);
    expect(got.text).toBe("Hi.\n\nMore words.\n\nThe end.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
  });

  it("draws no card for an example in a json fence when the message goes on after it", () => {
    const got = extractRichContentFromBody(`This is the block a bot writes:\n\n${fenced(CONNECT, "json")}\n\nIt draws one card per item.`);
    expect(got.rich).toBeNull();
    // The envelope is cut, as it was before the app knew the kind.
    expect(got.text).toBe("This is the block a bot writes:\n\nIt draws one card per item.");
  });

  it("draws no card for an example in an unlabelled fence when the message goes on after it", () => {
    const got = extractRichContentFromBody("Like this:\n\n```\n" + CONNECT + "\n```\n\nGot it?");
    expect(got.rich).toBeNull();
    expect(got.text).toBe("Like this:\n\nGot it?");
  });

  it("draws no card for a json example and still lifts the bot's own hq-block fence after it", () => {
    const got = extractRichContentFromBody(`An example:\n\n${fenced(CONNECT, "json")}\n\nAnd here are your replies.\n\n${fenced(SUGGESTIONS)}`);
    expect(got.text).toBe("An example:\n\nAnd here are your replies.");
    expect(got.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions"]);
  });

  it("keeps the block a loose envelope carries next to a connect block, and drops the connect block", () => {
    const mixed = envelope({ kind: "connect", items: [{ domain: "linear.app" }] }, { kind: "markdown", text: "The read." });
    const got = extractRichContentFromBody(`Look.\n\n${fenced(mixed, "json")}\n\nMore.`);
    expect(got.rich?.blocks).toEqual([{ kind: "markdown", text: "The read." }]);
    expect(got.text).toBe("Look.\n\nMore.");
  });

  it("never draws a card from an envelope inside a larger JSON object, an array, a string or inline code", () => {
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
      expect(cards(got), body).toBe(0);
      expect(got.rich, body).toBeNull();
    }
  });

  it("draws no card from an envelope with no fence that is not the last thing in the message", () => {
    const got = extractRichContentFromBody(`Before.\n\n${CONNECT}\n\nAfter.`);
    expect(got.rich).toBeNull();
    expect(got.text).toBe("Before.\n\nAfter.");
  });

  it("lifts an envelope with no fence at the very end", () => {
    const one = extractRichContentFromBody(`All set.\n\n${CONNECT}\n  `);
    expect(one.text).toBe("All set.");
    expect(one.rich?.blocks.map((block) => block.kind)).toEqual(["connect"]);
    // Suggested replies before it are lifted from where they are, as they always were.
    const two = extractRichContentFromBody(`All set.\n\n${SUGGESTIONS}\n\n${CONNECT}`);
    expect(two.rich?.blocks.map((block) => block.kind)).toEqual(["suggestions", "connect"]);
    expect(two.text).toBe("All set.");
  });

  it("never draws a card from an hq-block fence that sits inside another fence", () => {
    const inner = fenced(CONNECT);
    const mid = extractRichContentFromBody("How a bot writes it:\n\n````markdown\nSome words.\n\n" + inner + "\n````\n\nThat is all.");
    expect(mid.rich).toBeNull();
    // The same example as the last thing in the message is still an example.
    const last = extractRichContentFromBody("How a bot writes it:\n\n````markdown\nSome words.\n\n" + inner + "\n````");
    expect(last.rich).toBeNull();
  });

  it("draws no card from an hq-block fence whose content is more than one envelope", () => {
    for (const content of ["not json", `{"port":3000}`, `${CONNECT}\n${SUGGESTIONS}`, `see: ${CONNECT}`, ""]) {
      const got = extractRichContentFromBody(`Look.\n\n${fenced(content)}`);
      expect(cards(got), content).toBe(0);
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

describe("replyForSuggestion: what a pressed suggestion sends", () => {
  const texts = { "Connect more tools": "Connect more tools", Yes: "Yes, go ahead." };

  it("sends the host's text for a label it has, else the label itself", () => {
    expect(replyForSuggestion("Yes", texts)).toBe("Yes, go ahead.");
    expect(replyForSuggestion("No", texts)).toBe("No");
    expect(replyForSuggestion("Yes", null)).toBe("Yes");
    expect(replyForSuggestion("Yes", undefined)).toBe("Yes");
  });

  it("sends the label, never what an object keeps under a built-in name", () => {
    // The label is the bot's. Every object has these names on it.
    for (const label of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf", "toLocaleString"]) {
      const sent = replyForSuggestion(label, texts);
      expect(sent, label).toBe(label);
      expect(typeof sent).toBe("string");
      expect(replyForSuggestion(label, {})).toBe(label);
    }
  });

  it("sends the label when the host's entry is not text", () => {
    expect(replyForSuggestion("Yes", { Yes: 3 as unknown as string })).toBe("Yes");
    // An own key named like a built-in is the host's own and is used.
    expect(replyForSuggestion("constructor", { constructor: "Build it" } as Record<string, string>)).toBe("Build it");
  });
});
