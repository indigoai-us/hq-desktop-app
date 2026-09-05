import { describe, expect, it } from "vitest";
import {
  GENUI_ENABLED,
  extractRichContentFromBody,
  parseRichContent,
  richContentForMessage,
  richContentToPlainText,
  toSafeText,
} from "./richMessageContent.js";

describe("parseRichContent — version + envelope gating", () => {
  it("returns null for non-objects and empty envelopes", () => {
    expect(parseRichContent(null)).toBeNull();
    expect(parseRichContent("nope")).toBeNull();
    expect(parseRichContent([])).toBeNull();
    expect(parseRichContent({})).toBeNull();
    expect(parseRichContent({ v: 1, blocks: [] })).toBeNull();
    expect(parseRichContent({ v: 1, blocks: "x" })).toBeNull();
  });

  it("rejects an unknown version", () => {
    expect(
      parseRichContent({ v: 2, blocks: [{ kind: "markdown", text: "hi" }] }),
    ).toBeNull();
  });

  it("treats an absent version as v1 (tolerant)", () => {
    const model = parseRichContent({
      blocks: [{ kind: "markdown", text: "hi" }],
    });
    expect(model?.blocks).toHaveLength(1);
  });

  it("drops unknown block kinds but keeps the valid ones", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "mystery" },
        { kind: "markdown", text: "kept" },
        { notAKind: true },
      ],
    });
    expect(model?.blocks).toHaveLength(1);
    expect(model?.blocks[0]).toMatchObject({ kind: "markdown", text: "kept" });
  });
});

describe("stat block", () => {
  it("parses label/value/delta/trend and coerces value types", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "stat",
          items: [
            { label: "MRR", value: 42000, delta: "+12%", trend: "up" },
            { label: "Churn", value: "1.8%", trend: "down" },
            { junk: true },
          ],
        },
      ],
    });
    const block = model?.blocks[0];
    expect(block).toMatchObject({ kind: "stat" });
    if (block?.kind !== "stat") throw new Error("expected stat");
    expect(block.items).toHaveLength(2);
    expect(block.items[0]).toEqual({
      label: "MRR",
      value: "42000",
      delta: "+12%",
      trend: "up",
    });
    expect(block.items[1].trend).toBe("down");
    expect(block.items[1].delta).toBeUndefined();
  });

  it("returns null when no stat item is usable", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "stat", items: [{}, { label: "", value: "" }] }],
    });
    expect(model).toBeNull();
  });
});

describe("table block", () => {
  it("normalizes ragged rows to a fixed width and coerces cells to text", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "table",
          columns: ["Repo", "PRs", "Deploys"],
          rows: [
            ["hq-pro", 12, 3],
            ["hq-desktop-app", 7],
          ],
          align: ["left", "right", "right"],
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "table") throw new Error("expected table");
    expect(block.columns).toEqual(["Repo", "PRs", "Deploys"]);
    expect(block.rows[0]).toEqual(["hq-pro", "12", "3"]);
    expect(block.rows[1]).toEqual(["hq-desktop-app", "7", ""]);
    expect(block.align).toEqual(["left", "right", "right"]);
  });
});

describe("chart block", () => {
  it("parses a line chart, dropping non-finite points", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "chart",
          chartType: "line",
          series: [
            { name: "Signups", data: [1, 2, "3", null, Infinity, 5] },
            { name: "empty", data: [] },
          ],
          categories: ["Mon", "Tue", "Wed"],
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "chart") throw new Error("expected chart");
    expect(block.chartType).toBe("line");
    expect(block.series).toHaveLength(1);
    expect(block.series[0].data).toEqual([1, 2, 3, 5]);
    expect(block.categories).toEqual(["Mon", "Tue", "Wed"]);
  });

  it("defaults an unknown chartType to line and requires a series", () => {
    expect(
      parseRichContent({
        v: 1,
        blocks: [{ kind: "chart", chartType: "pie", series: [] }],
      }),
    ).toBeNull();
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "chart", chartType: "pie", series: [{ name: "a", data: [1] }] },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "chart") throw new Error("expected chart");
    expect(block.chartType).toBe("line");
  });
});

describe("badge block", () => {
  it("parses label + tone and maps an unknown tone to the neutral default", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "badge", label: "Live", tone: "success" },
        { kind: "badge", label: "Weird", tone: "chartreuse" },
        { kind: "badge", label: "Plain" },
      ],
    });
    expect(model?.blocks).toHaveLength(3);
    expect(model?.blocks[0]).toEqual({ kind: "badge", label: "Live", tone: "success" });
    // Unknown enum value → default, never the raw agent value.
    expect(model?.blocks[1]).toEqual({ kind: "badge", label: "Weird", tone: "neutral" });
    expect(model?.blocks[2]).toEqual({ kind: "badge", label: "Plain", tone: "neutral" });
  });

  it("drops a badge with no label (empty → null)", () => {
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "badge", tone: "danger" }] }),
    ).toBeNull();
  });

  it("keeps a malicious label as inert text (no markup interpreted)", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "badge", label: "<img src=x onerror=alert(1)>", tone: "info" }],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "badge") throw new Error("expected badge");
    // The angle brackets survive as literal text (escaped by the renderer at
    // bind time); `info` is not a badge tone so it collapses to neutral.
    expect(block.label).toBe("<img src=x onerror=alert(1)>");
    expect(block.tone).toBe("neutral");
  });
});

describe("keyValue block", () => {
  it("parses rows and coerces both sides to text", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "keyValue",
          items: [
            { key: "Owner", value: "Corey" },
            { key: "Open PRs", value: 7 },
            { junk: true },
            { key: "", value: "" },
          ],
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "keyValue") throw new Error("expected keyValue");
    expect(block.items).toEqual([
      { key: "Owner", value: "Corey" },
      { key: "Open PRs", value: "7" },
    ]);
  });

  it("returns null when no row is usable, and caps oversized item lists", () => {
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "keyValue", items: [{}, {}] }] }),
    ).toBeNull();
    const many = Array.from({ length: 500 }, (_, i) => ({ key: `k${i}`, value: `${i}` }));
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "keyValue", items: many }],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "keyValue") throw new Error("expected keyValue");
    expect(block.items.length).toBeLessThanOrEqual(50);
  });

  it("keeps injected markup as inert text", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "keyValue",
          items: [{ key: "<b>k</b>", value: "<script>alert(1)</script>" }],
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "keyValue") throw new Error("expected keyValue");
    expect(block.items[0]).toEqual({
      key: "<b>k</b>",
      value: "<script>alert(1)</script>",
    });
  });
});

describe("progress block", () => {
  it("clamps value to [0,100] and carries a valid tone", () => {
    const over = parseRichContent({
      v: 1,
      blocks: [{ kind: "progress", label: "Rollout", value: 150, tone: "accent" }],
    });
    expect(over?.blocks[0]).toEqual({
      kind: "progress",
      label: "Rollout",
      value: 100,
      tone: "accent",
    });
    const under = parseRichContent({
      v: 1,
      blocks: [{ kind: "progress", value: -20 }],
    });
    expect(under?.blocks[0]).toEqual({ kind: "progress", value: 0 });
  });

  it("coerces a numeric string and drops an unknown tone to neutral", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "progress", value: "42", tone: "ultraviolet" }],
    });
    expect(model?.blocks[0]).toEqual({ kind: "progress", value: 42, tone: "neutral" });
  });

  it("returns null when value is missing or non-finite", () => {
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "progress", label: "x" }] }),
    ).toBeNull();
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "progress", value: "nope" }] }),
    ).toBeNull();
  });
});

describe("callout block", () => {
  it("parses tone + title + body and defaults an unknown tone to info", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "callout", tone: "warning", title: "Heads up", body: "**bold** note" },
        { kind: "callout", tone: "chartreuse", body: "no title here" },
      ],
    });
    expect(model?.blocks[0]).toEqual({
      kind: "callout",
      tone: "warning",
      title: "Heads up",
      body: "**bold** note",
    });
    // Unknown tone → default, and title omitted when absent.
    expect(model?.blocks[1]).toEqual({
      kind: "callout",
      tone: "info",
      body: "no title here",
    });
  });

  it("returns null with no body (empty → null)", () => {
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "callout", tone: "info", title: "t" }] }),
    ).toBeNull();
  });

  it("accepts a `text` alias for `body` (emitter used the markdown field name)", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "callout", tone: "success", title: "Runtime", text: "v2.17" }],
    });
    expect(model?.blocks[0]).toEqual({
      kind: "callout",
      tone: "success",
      title: "Runtime",
      body: "v2.17",
    });
  });

  it("prefers `body` over `text` when both are present", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "callout", tone: "info", body: "canonical", text: "alias" }],
    });
    expect(model?.blocks[0]).toMatchObject({ kind: "callout", body: "canonical" });
  });

  it("still rejects a callout with neither body nor text", () => {
    expect(
      parseRichContent({
        v: 1,
        blocks: [{ kind: "callout", tone: "info", title: "t", extra: "x" }],
      }),
    ).toBeNull();
  });

  it("still rejects a callout whose text alias is an empty string", () => {
    expect(
      parseRichContent({ v: 1, blocks: [{ kind: "callout", tone: "info", text: "" }] }),
    ).toBeNull();
  });

  it("the `text` alias is sanitized through the same renderer path", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "callout",
          tone: "danger",
          text: "<script>alert(1)</script> [x](javascript:alert(1))",
          onClick: "doEvil()",
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "callout") throw new Error("expected callout");
    // Only typed fields survive; alias carries no extra markup path.
    expect(Object.keys(block).sort()).toEqual(["body", "kind", "tone"]);
    expect(JSON.stringify(model)).not.toContain("onClick");
  });

  it("body stays inert markdown text — no handler/script survives as a field", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        {
          kind: "callout",
          tone: "danger",
          title: "<img onerror=alert(1)>",
          body: "<script>alert(1)</script> and a [link](javascript:alert(1))",
          // hostile extra fields the contract never reads:
          html: "<iframe>",
          onClick: "doEvil()",
        },
      ],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "callout") throw new Error("expected callout");
    // Only the typed fields are carried; no html/onClick reaches the model.
    expect(Object.keys(block).sort()).toEqual(["body", "kind", "title", "tone"]);
    expect(JSON.stringify(model)).not.toContain("onClick");
    expect(JSON.stringify(model)).not.toContain("<iframe");
  });
});

describe("markdown block", () => {
  it("accepts a `body` alias for `text` (symmetric with callout)", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "markdown", body: "aliased prose" }],
    });
    expect(model?.blocks[0]).toEqual({ kind: "markdown", text: "aliased prose" });
  });

  it("prefers `text` over `body` when both are present", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "markdown", text: "canonical", body: "alias" }],
    });
    expect(model?.blocks[0]).toMatchObject({ kind: "markdown", text: "canonical" });
  });

  it("still rejects a markdown block with neither text nor body", () => {
    expect(parseRichContent({ v: 1, blocks: [{ kind: "markdown" }] })).toBeNull();
  });
});

describe("richContentToPlainText — every block contributes fallback text", () => {
  it("projects each new block kind into readable text", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "badge", label: "Shipped", tone: "success" },
        {
          kind: "keyValue",
          items: [
            { key: "Owner", value: "Corey" },
            { key: "PRs", value: "7" },
          ],
        },
        { kind: "progress", label: "Rollout", value: 80, tone: "accent" },
        { kind: "callout", tone: "warning", title: "Heads up", body: "check the logs" },
      ],
    });
    if (!model) throw new Error("expected model");
    const text = richContentToPlainText(model);
    expect(text).toContain("Shipped");
    expect(text).toContain("Owner: Corey");
    expect(text).toContain("PRs: 7");
    expect(text).toContain("Rollout: 80%");
    expect(text).toContain("Heads up — check the logs");
  });

  it("still projects the shipped block kinds", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "stat", items: [{ label: "MRR", value: "$42k", delta: "+12%" }] },
        { kind: "markdown", text: "hello" },
      ],
    });
    if (!model) throw new Error("expected model");
    const text = richContentToPlainText(model);
    expect(text).toContain("MRR: $42k (+12%)");
    expect(text).toContain("hello");
  });
});

describe("sanitization — a payload can never inject executable content", () => {
  it("toSafeText strips control characters and never emits raw tags as markup", () => {
    // The value stays a plain string; escaping to HTML happens at bind time in
    // the Svelte renderer. Here we only assert control chars are removed and the
    // string is inert data (not parsed/executed).
    expect(toSafeText("a bc")).toBe("abc");
    expect(toSafeText(123)).toBe("123");
    expect(toSafeText({})).toBe("");
    // Angle brackets survive as literal text (the renderer escapes them); they
    // are never interpreted here.
    expect(toSafeText("<script>x</script>")).toBe("<script>x</script>");
  });

  it("caps oversized payloads (blocks, rows, series points)", () => {
    const bigRows = Array.from({ length: 500 }, (_, i) => [String(i)]);
    const model = parseRichContent({
      v: 1,
      blocks: [{ kind: "table", columns: ["n"], rows: bigRows }],
    });
    const block = model?.blocks[0];
    if (block?.kind !== "table") throw new Error("expected table");
    expect(block.rows.length).toBeLessThanOrEqual(100);
  });
});

describe("GenUI is design-only, behind a disabled flag", () => {
  it("the flag is OFF", () => {
    expect(GENUI_ENABLED).toBe(false);
  });

  it("drops a genui block so no agent-authored markup is rendered", () => {
    const model = parseRichContent({
      v: 1,
      blocks: [
        { kind: "genui", html: "<img src=x onerror=alert(1)>" },
        { kind: "markdown", text: "safe" },
      ],
    });
    // The genui block never becomes a render model.
    expect(model?.blocks).toHaveLength(1);
    expect(model?.blocks[0].kind).toBe("markdown");
    expect(JSON.stringify(model)).not.toContain("onerror");
  });
});

describe("hq-block fence extraction + plain-text fallback", () => {
  it("lifts a fenced hq-block out of body and keeps prose as the fallback", () => {
    const body = [
      "Here is the weekly read.",
      "",
      "```hq-block",
      JSON.stringify({
        v: 1,
        blocks: [{ kind: "stat", items: [{ label: "MRR", value: "$42k" }] }],
      }),
      "```",
      "",
      "Ping me if you want the breakdown.",
    ].join("\n");
    const { text, rich } = extractRichContentFromBody(body);
    expect(rich?.blocks[0].kind).toBe("stat");
    expect(text).toContain("Here is the weekly read.");
    expect(text).toContain("Ping me if you want the breakdown.");
    expect(text).not.toContain("hq-block");
    expect(text).not.toContain("MRR"); // structured data left the text fallback
  });

  it("leaves the body untouched when the fence JSON is invalid (degrades)", () => {
    const body = "before\n\n```hq-block\n{ not json ]\n```\n\nafter";
    const { text, rich } = extractRichContentFromBody(body);
    expect(rich).toBeNull();
    expect(text).toBe(body);
  });

  it("returns the plain body when there is no fence", () => {
    const { text, rich } = extractRichContentFromBody("just a normal reply");
    expect(rich).toBeNull();
    expect(text).toBe("just a normal reply");
  });
});

describe("richContentForMessage — field precedence + fallback guarantee", () => {
  it("prefers the explicit richContent wire field over a body fence", () => {
    const { text, rich } = richContentForMessage({
      body: "fallback text",
      richContent: {
        v: 1,
        blocks: [{ kind: "markdown", text: "from field" }],
      },
    });
    expect(rich?.blocks[0]).toMatchObject({ kind: "markdown", text: "from field" });
    expect(text).toBe("fallback text"); // body is the untouched fallback
  });

  it("falls back to fence extraction when there is no field", () => {
    const { rich } = richContentForMessage({
      body: "x\n\n```hq-block\n{\"v\":1,\"blocks\":[{\"kind\":\"markdown\",\"text\":\"y\"}]}\n```",
    });
    expect(rich?.blocks[0]).toMatchObject({ kind: "markdown", text: "y" });
  });

  it("always yields a valid text fallback even with no rich content", () => {
    const { text, rich } = richContentForMessage({ body: "plain" });
    expect(rich).toBeNull();
    expect(text).toBe("plain");
  });
});
