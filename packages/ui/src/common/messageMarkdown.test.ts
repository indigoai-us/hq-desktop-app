import { describe, expect, it } from "vitest";

import {
  clipMessageBodyForDisplay,
  isHeavyMessageBody,
  MESSAGE_PLAIN_DISPLAY_CHARS,
  renderMessageBodyMarkdown,
} from "./messageMarkdown.js";

describe("heavy message bodies", () => {
  it("treats large JSON dumps as heavy and renders them as a plain pre", () => {
    const body =
      `${JSON.stringify({ outcome: "doc-wrong", commandsRun: ["a"] })}\n`.repeat(
        40,
      );
    expect(body.length).toBeGreaterThan(400);
    expect(isHeavyMessageBody(body)).toBe(true);
    const started = Date.now();
    const html = renderMessageBodyMarkdown(body);
    expect(Date.now() - started).toBeLessThan(50);
    expect(html.startsWith('<pre class="dm-plain">')).toBe(true);
    expect(html).toContain("doc-wrong");
    expect(html).not.toContain("<p>");
  });

  it("clips huge dumps so the DOM does not receive the full log", () => {
    const body = `{"k":"${"x".repeat(12_000)}"}`;
    const html = renderMessageBodyMarkdown(body);
    expect(html.length).toBeLessThan(body.length);
    expect(html).toContain("…");
    expect(clipMessageBodyForDisplay(body).length).toBeLessThanOrEqual(
      MESSAGE_PLAIN_DISPLAY_CHARS + 2,
    );
  });

  it("keeps a window of long English docs cheap to render", () => {
    const bodies = Array.from(
      { length: 40 },
      (_, i) =>
        `You are testing HQ as a new team member ${i}\n\n${"paragraph ".repeat(200)}`,
    );
    const started = performance.now();
    const html = bodies.map((body) => renderMessageBodyMarkdown(body));
    expect(performance.now() - started).toBeLessThan(50);
    expect(html.every((row) => row.startsWith('<pre class="dm-plain">'))).toBe(
      true,
    );
    expect(Math.max(...html.map((row) => row.length))).toBeLessThan(800);
  });

  it("still renders short chat markdown", () => {
    const html = renderMessageBodyMarkdown("hello **Deacon**");
    expect(isHeavyMessageBody("hello **Deacon**")).toBe(false);
    expect(html).toContain("<strong>Deacon</strong>");
  });
});

describe("message body URL autolinking", () => {
  it("autolinks bare http and https URLs with rel=noopener noreferrer", () => {
    const http = renderMessageBodyMarkdown("see http://example.com/docs");
    expect(http).toContain(
      '<a href="http://example.com/docs" target="_blank" rel="noopener noreferrer">http://example.com/docs</a>',
    );
    const https = renderMessageBodyMarkdown("see https://example.com/docs");
    expect(https).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>',
    );
  });

  it("does not swallow a trailing period after a bare URL", () => {
    const html = renderMessageBodyMarkdown("See https://example.com.");
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.',
    );
    expect(html).not.toContain('href="https://example.com."');
  });

  it("still renders markdown [label](https://…) links", () => {
    const html = renderMessageBodyMarkdown("see [docs](https://example.com/x)");
    expect(html).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it("never turns javascript:alert(1) into a link as markdown or bare text", () => {
    const markdown = renderMessageBodyMarkdown("[x](javascript:alert(1))");
    expect(markdown).not.toMatch(/<a\b/);
    expect(markdown).not.toContain("javascript:");

    const bare = renderMessageBodyMarkdown("javascript:alert(1)");
    expect(bare).not.toMatch(/<a\b/);
    expect(bare).toContain("javascript:alert(1)");
  });

  it("does not autolink URLs inside fenced or inline code", () => {
    const fenced = renderMessageBodyMarkdown("```\nhttps://example.com\n```");
    expect(fenced).toContain("<pre><code>https://example.com</code></pre>");
    expect(fenced).not.toMatch(/<a\b/);

    const inline = renderMessageBodyMarkdown("use `https://example.com` here");
    expect(inline).toContain("<code>https://example.com</code>");
    expect(inline).not.toMatch(/<a\b/);
  });

  it("does not double-link text inside an existing markdown link", () => {
    const html = renderMessageBodyMarkdown(
      "[https://example.com](https://example.com/page)",
    );
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain(">https://example.com</a>");
  });

  it("preserves escaped &amp; in a URL and does not decode it", () => {
    const html = renderMessageBodyMarkdown("https://example.com?a=1&b=2");
    expect(html).toContain(
      '<a href="https://example.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com?a=1&amp;b=2</a>',
    );
    expect(html).not.toContain('href="https://example.com?a=1&b=2"');
  });
});
