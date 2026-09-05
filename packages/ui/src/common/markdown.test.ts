import { describe, expect, it } from "vitest";
import {
  renderInline,
  renderMarkdown,
  renderMarkdownDocument,
  safeHref,
  safeImageSrc,
} from "./markdown";

describe("desktop markdown rendering", () => {
  it("hides YAML frontmatter and renders the document body normally", () => {
    const html = renderMarkdownDocument(
      [
        "---",
        "type: knowledge",
        "status: active",
        "tags:",
        "  - operations",
        "---",
        "",
        "# Retention dashboard",
        "",
        "| Step | Owner |",
        "| --- | --- |",
        "| Refresh | RevOps |",
      ].join("\n"),
    );

    expect(html).not.toContain("type: knowledge");
    expect(html).not.toContain("status: active");
    expect(html).toContain("<h1>Retention dashboard</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>RevOps</td>");
  });

  it("keeps a leading horizontal rule when no valid YAML envelope exists", () => {
    const html = renderMarkdownDocument(["---", "", "Visible body"].join("\n"));

    expect(html).toContain("<hr />");
    expect(html).toContain("<p>Visible body</p>");
  });

  it("preserves YAML-shaped content inside nested Markdown blocks", () => {
    const html = renderMarkdownDocument(
      [
        "> ---",
        "> title: Quoted metadata example",
        "> ---",
        "> Still visible",
        "",
        "<details open>",
        "<summary>Example</summary>",
        "",
        "---",
        "title: Disclosure metadata example",
        "---",
        "Still visible too",
        "</details>",
      ].join("\n"),
    );

    expect(html).toContain("Quoted metadata example");
    expect(html).toContain("Still visible");
    expect(html).toContain("Disclosure metadata example");
    expect(html).toContain("Still visible too");
  });

  it("renders a GFM table as semantic HTML instead of raw pipe text", () => {
    const html = renderMarkdown(
      [
        "| Community | Direction | Households | Median income |",
        "| :--- | :---: | ---: | --- |",
        "| Lyons | center | 1,930 | **$121K** |",
        "| Eagle Canyon | N | n/a | $875K–$985K |",
      ].join("\n"),
    );

    expect(html).toContain(
      '<div class="markdown-table-scroll" tabindex="0"><table>',
    );
    expect(html).toContain("<thead><tr>");
    expect(html).toContain(
      '<th scope="col" class="markdown-align-left">Community</th>',
    );
    expect(html).toContain(
      '<th scope="col" class="markdown-align-center">Direction</th>',
    );
    expect(html).toContain(
      '<th scope="col" class="markdown-align-right">Households</th>',
    );
    expect(html).toContain(
      '<tbody><tr><td class="markdown-align-left">Lyons</td>',
    );
    expect(html).toContain("<strong>$121K</strong>");
    expect(html).not.toContain("<p>| Community");
  });

  it("keeps escaped and code-span pipes inside table cells", () => {
    const html = renderMarkdown(
      ["Name | Value", "--- | ---", "literal \\| pipe | `a | b`"].join("\n"),
    );

    expect(html).toContain("<td>literal | pipe</td>");
    expect(html).toContain("<td><code>a | b</code></td>");
  });

  it("keeps HQ wikilink labels readable without splitting table columns", () => {
    const html = renderMarkdown(
      [
        "| Competitor | Focus | Differentiator |",
        "| --- | --- | --- |",
        "| Fathom | Free [[ontology/entities/concept/meeting-intelligence|meeting notes]] | Persistent memory |",
      ].join("\n"),
    );

    expect(html).toContain(
      '<td>Free <span class="markdown-wikilink" title="ontology/entities/concept/meeting-intelligence">meeting notes</span></td>',
    );
    expect(html).toContain("<td>Persistent memory</td>");
    expect(html).not.toContain("[[");
    expect(html.match(/<td>/g)).toHaveLength(3);
  });

  it("renders unlabeled wikilinks with their final path segment", () => {
    const html = renderInline("See [[ontology/entities/company/indigo]] now");

    expect(html).toContain(
      'See <span class="markdown-wikilink" title="ontology/entities/company/indigo">indigo</span> now',
    );
    expect(html).not.toContain("[[");
  });

  it("degrades malformed table delimiters to safe paragraph text", () => {
    const html = renderMarkdown(
      ["| Name | Value |", "| --- | :-- |", "| safe | <script> |"].join("\n"),
    );

    expect(html).not.toContain("<table>");
    expect(html).toContain("| Name | Value |");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&lt;script&gt;");
  });

  it("renders nested lists and multi-line list items without losing content", () => {
    const html = renderMarkdown(
      [
        "- Parent item",
        "  continues on the next line",
        "  1. Nested first",
        "     with more detail",
        "  2. Nested second",
        "- Next parent",
      ].join("\n"),
    );

    expect(html).toBe(
      "<ul><li>Parent item continues on the next line<ol><li>Nested first with more detail</li><li>Nested second</li></ol></li><li>Next parent</li></ul>",
    );
  });

  it("renders headings, paragraphs, hard breaks, lists, tasks, quotes, rules, and code", () => {
    const html = renderMarkdown(
      [
        "Setext title",
        "============",
        "",
        "## Heading",
        "",
        "first line  ",
        "second line",
        "",
        "- ordinary",
        "- [x] shipped",
        "- [ ] follow up",
        "",
        "1. first",
        "2. second",
        "",
        "> **Quoted** text",
        "> - with a list",
        "",
        "---",
        "",
        "```ts",
        'const safe = "<tag>";',
        "```",
        "",
        "    indented()",
      ].join("\n"),
    );

    expect(html).toContain("<h1>Setext title</h1>");
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<p>first line<br />second line</p>");
    expect(html).toContain('<ul class="task-list">');
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled checked /><div class="task-list-content">',
    );
    expect(html).toContain("<ol><li>first</li><li>second</li></ol>");
    expect(html).toContain("<blockquote><p><strong>Quoted</strong> text</p>");
    expect(html).toContain("<ul><li>with a list</li></ul></blockquote>");
    expect(html).toContain("<hr />");
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain("&lt;tag&gt;");
    expect(html).toContain("<pre><code>indented()</code></pre>");
  });

  it("renders safe links, autolinks, image fallbacks, emphasis, deletion, and escaped punctuation", () => {
    const html = renderInline(
      String.raw`[HQ](https://example.com) <team@example.com> ![Map](/map.png) **bold** _em_ ~~old~~ \*literal\*`,
    );

    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<a href="mailto:team@example.com"');
    expect(html).toContain("Map");
    expect(html).not.toContain("<img");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<del>old</del>");
    expect(html).toContain("*literal*");
  });

  it("restores inline-code fragments nested inside link labels", () => {
    const html = renderInline(
      "[`@indigoai-us/hq-pack-*`](https://www.npmjs.com/search?q=hq-pack)",
    );

    expect(html).toContain(
      '<a href="https://www.npmjs.com/search?q=hq-pack" target="_blank" rel="noopener noreferrer"><code>@indigoai-us/hq-pack-*</code></a>',
    );
    expect(html).not.toContain("FRAGMENT");
  });

  it("renders the narrow raw HTML subset without auto-loading remote README artwork", () => {
    const html = renderMarkdown(
      [
        '<p align="center" class="ignored" onclick="alert(1)">',
        '  <img src="https://example.com/hq.png" alt="HQ" width="180" height="80" style="display:none" onerror="alert(2)">',
        "  <br>",
        "  **The operating system for teams.**",
        "</p>",
      ].join("\n"),
    );

    expect(html).toBe(
      '<p class="markdown-align-center">HQ <br /> <strong>The operating system for teams.</strong></p>',
    );
    expect(html).not.toContain("&lt;p");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("style=");
  });

  it("never emits remote image requests from Markdown or raw HTML", () => {
    const html = renderMarkdown(
      [
        "![Remote](https://tracker.example/pixel.png)",
        "![Insecure](http://tracker.example/pixel.png)",
        '<img src="https://tracker.example/raw.png" alt="Raw remote">',
        "",
        "![Local](/images/local.png)",
      ].join("\n"),
    );

    expect(safeImageSrc("https://tracker.example/pixel.png")).toBeNull();
    expect(safeImageSrc("http://tracker.example/pixel.png")).toBeNull();
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("Remote");
    expect(html).toContain("Insecure");
    expect(html).toContain("Raw remote");
    expect(html).toContain("Local");
    expect(html).not.toContain("<img");
    expect(safeImageSrc("/images/local.png")).toBeNull();
  });

  it("renders README details and summary blocks while continuing to parse Markdown", () => {
    const html = renderMarkdown(
      [
        '<details open ontoggle="alert(1)">',
        "<summary>Install **HQ**</summary>",
        "",
        "Run `hq setup`.",
        "",
        "- Verify sync",
        "</details>",
      ].join("\n"),
    );

    expect(html).toBe(
      "<details open><summary>Install <strong>HQ</strong></summary><p>Run <code>hq setup</code>.</p>\n<ul><li>Verify sync</li></ul></details>",
    );
    expect(html).not.toContain("&lt;details");
    expect(html).not.toContain("ontoggle");
  });

  it("suppresses unsafe and unsupported raw HTML without exposing executable markup", () => {
    const html = renderMarkdown(
      [
        "<!-- internal README note -->",
        '<p align="center">',
        '<img src="javascript:alert(1)" alt="unsafe" onerror="alert(2)">',
        '<script>alert("script")</script>',
        "<style>body { display: none }</style>",
        '<iframe src="https://example.com">frame fallback</iframe>',
        '<img-widget src="https://example.com/tracker.png"></img-widget>',
        '<a href="javascript:alert(3)">Visible label</a>',
        "</p>",
      ].join("\n"),
    );

    expect(html).toContain('<p class="markdown-align-center">');
    expect(html).toContain("unsafe");
    expect(html).toContain("Visible label");
    expect(html).not.toContain("&lt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain("tracker.png");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain('script")');
    expect(html).not.toContain("display: none");
    expect(html).not.toContain("frame fallback");
    expect(html).not.toContain("internal README note");
  });

  it("preserves raw HTML examples inside inline and fenced code", () => {
    const html = renderMarkdown(
      [
        "Inline `<script>alert(1)</script>` example.",
        "",
        "```html",
        '<iframe src="https://example.com">fallback</iframe>',
        "```",
        "",
        '    <p align="center">literal paragraph</p>',
        "    <script>alert(2)</script>",
      ].join("\n"),
    );

    expect(html).toContain(
      "<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
    );
    expect(html).toContain(
      '<pre><code class="language-html">&lt;iframe src=&quot;https://example.com&quot;&gt;fallback&lt;/iframe&gt;</code></pre>',
    );
    expect(html).toContain(
      "<pre><code>&lt;p align=&quot;center&quot;&gt;literal paragraph&lt;/p&gt;\n&lt;script&gt;alert(2)&lt;/script&gt;</code></pre>",
    );
  });

  it("requires table headers and delimiters to have the same column count", () => {
    const html = renderMarkdown(
      ["A | B", "--- | --- | ---", "1 | 2"].join("\n"),
    );

    expect(html).not.toContain("<table>");
    expect(html).toContain("A | B");
  });

  it("suppresses unsafe raw HTML and never emits unsafe link or image schemes", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,x)",
    );

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("&lt;script&gt;");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(safeHref("//example.com")).toBeNull();
    expect(safeHref("\\\\example.com")).toBeNull();
    expect(safeImageSrc("mailto:team@example.com")).toBeNull();
    expect(safeImageSrc("#local")).toBeNull();
  });
});

describe("softBreak option (chat vs document)", () => {
  it("defaults soft newlines to a space (CommonMark, knowledge docs)", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toContain("line one line two");
    expect(html).not.toContain("<br />");
  });

  it("emits <br /> for soft newlines when softBreak is 'br'", () => {
    const html = renderMarkdown("line one\nline two", { softBreak: "br" });
    expect(html).toContain("line one<br />line two");
  });

  it("keeps explicit hard breaks regardless of the softBreak option", () => {
    const html = renderMarkdown("line one  \nline two");
    expect(html).toContain("line one<br />line two");
  });

  it("documents (renderMarkdownDocument) keep the space default", () => {
    const html = renderMarkdownDocument("alpha\nbeta");
    expect(html).toContain("alpha beta");
    expect(html).not.toContain("<br />");
  });
});
