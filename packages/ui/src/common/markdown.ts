/**
 * Small, dependency-free, CSP-safe Markdown → HTML renderer (US-009).
 *
 * Choice: rather than pull in a markdown dependency (`marked` + a DOM
 * sanitizer) into this Tauri webview — which would add bundle weight and a
 * `dangerouslySetInnerHTML`-equivalent surface that needs CSP carve-outs — we
 * implement the document constructs used by HQ knowledge files by hand. The
 * output is built from escaped text and a fixed set of safe tags. A narrow
 * README-oriented HTML subset (`p`/`div` alignment, `img`, `br`, and
 * `details`/`summary`) is parsed and rebuilt from validated values; raw source
 * HTML is never passed through. The only attributes emitted are fixed
 * accessibility attributes, safe presentation values, and validated `href`
 * values. Inline image markup degrades to its alt text so the webview never
 * performs a renderer-side image request. No `eval`, no arbitrary source HTML,
 * no external libs.
 *
 * Supported: ATX + Setext headings, paragraphs and hard line breaks, unordered,
 * ordered, and GFM task lists, fenced/indented code, inline code, bold, italic,
 * strikethrough, links, image fallbacks, autolinks, wikilink labels,
 * blockquotes, horizontal rules, and GFM tables, plus the sanitized README HTML
 * subset above. Unsupported HTML tags are suppressed while their ordinary text
 * remains visible.
 *
 * Pure (no Svelte runes, no Tauri imports) so it is trivially unit-testable.
 */

/** HTML-escape a raw string so it can never inject markup. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate a link URL. Only http(s) and mailto pass; everything else
 * (`javascript:`, `data:`, etc.) is rejected so it cannot become a clickable
 * script vector. Relative links are allowed (they just won't resolve in-app yet).
 */
export function safeHref(rawUrl: string): string | null {
  const url = rawUrl.trim();
  if (url === "") return null;
  if (/[\u0000-\u001f\u007f]/.test(url)) return null;
  // Relative or anchor links are safe to render (no scheme).
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    // Do not let protocol-relative or backslash-prefixed URLs escape the app's
    // origin. Plain relative paths and `#anchor` links are safe.
    if (/^(?:\/\/|\\\\)/.test(url)) return null;
    return url;
  }
  if (/^(https?:|mailto:)/i.test(url)) return url;
  return null;
}

/**
 * Images from untrusted Markdown must not initiate a renderer-side file or
 * network request.
 *
 * Unlike links, remote http(s) images are not passive: rendering one tells the
 * remote server that a specific message or file was opened and exposes network
 * metadata. Relative Markdown images are not safe to resolve against the Tauri
 * app origin either: they point at the packaged UI rather than the selected HQ
 * document and render as broken, oversized frames. Degrade every inline image
 * to its alt text here. Authorized native image previews use their own
 * size-capped data URL path outside this renderer.
 */
export function safeImageSrc(_rawUrl: string): string | null {
  return null;
}

/**
 * Remove a conventional YAML frontmatter envelope from the start of a
 * Markdown document. HQ knowledge metadata belongs to the file model, not the
 * rendered article body, so showing it as a paragraph makes an otherwise valid
 * document look broken.
 *
 * Be deliberately conservative: a leading horizontal rule remains ordinary
 * Markdown unless it has a closing delimiter and at least one YAML-style key.
 */
function withoutYamlFrontmatter(source: string): string {
  const normalized = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return normalized;

  const closingIndex = lines
    .slice(1, 201)
    .findIndex((line) => /^(?:---|\.\.\.)\s*\r?$/.test(line));
  if (closingIndex < 0) return normalized;

  const delimiterIndex = closingIndex + 1;
  const metadata = lines.slice(1, delimiterIndex);
  const hasYamlKey = metadata.some((line) =>
    /^[A-Za-z_][A-Za-z0-9_-]*\s*:\s*(?:.*)?\r?$/.test(line),
  );
  if (!hasYamlKey) return normalized;

  return lines
    .slice(delimiterIndex + 1)
    .join("\n")
    .replace(/^\s*\n/, "");
}

type RawHtmlAttributes = Map<string, string | null>;

/** Parse attributes for whitelisted tags; callers still choose which names survive. */
function parseRawHtmlAttributes(raw: string): RawHtmlAttributes {
  const attributes: RawHtmlAttributes = new Map();
  const pattern =
    /([a-z_:][a-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      attributes.set(name, match[2] ?? match[3] ?? match[4] ?? null);
    }
  }
  return attributes;
}

function safeImageDimension(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || !/^\d{1,4}$/.test(raw.trim()))
    return null;
  const value = Number(raw);
  return value > 0 && value <= 4096 ? String(value) : null;
}

function renderRawHtmlImage(rawAttributes: string): string {
  const attributes = parseRawHtmlAttributes(rawAttributes);
  const alt = attributes.get("alt") ?? "";
  const src = safeImageSrc(attributes.get("src") ?? "");
  if (src === null) return escapeHtml(alt ?? "");

  const title = attributes.get("title");
  const width = safeImageDimension(attributes.get("width"));
  const height = safeImageDimension(attributes.get("height"));
  const optional = [
    title ? ` title="${escapeHtml(title)}"` : "",
    width ? ` width="${width}"` : "",
    height ? ` height="${height}"` : "",
  ].join("");

  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt ?? "")}" loading="lazy" decoding="async"${optional} />`;
}

/**
 * Render inline markdown (bold, italic, inline code, links) inside an already
 * block-resolved line. Input is raw (unescaped) markdown text; output is safe
 * HTML. The order matters: code spans are extracted first so their contents are
 * not re-processed for emphasis.
 */
export function renderInline(text: string): string {
  const fragments: string[] = [];
  const stash = (html: string): string => {
    const index = fragments.push(html) - 1;
    return `\u0000FRAGMENT${index}\u0000`;
  };

  // Backslash-escaped markdown punctuation must stay literal through emphasis.
  let work = text.replace(
    /\\([\\`*_[\]{}()#+\-.!|>~])/g,
    (_match, character: string) => stash(escapeHtml(character)),
  );

  // Code spans are resolved first so markdown inside them remains literal.
  work = work.replace(
    /(`+)([\s\S]*?)\1/g,
    (_match, _ticks: string, code: string) =>
      stash(`<code>${escapeHtml(code.trim())}</code>`),
  );

  // Rebuild the tiny inline HTML subset used by READMEs. Attributes from source
  // never pass through: images retain only validated src/alt/title/dimensions,
  // and line breaks are emitted without attributes.
  work = work.replace(
    /<img(?=\s|\/?>)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/gi,
    (_match, attributes: string) => stash(renderRawHtmlImage(attributes)),
  );
  work = work.replace(/<br(?=\s|\/?>)[^<>]*\/?>/gi, () => stash("<br />"));

  // Images precede links because image syntax contains link syntax.
  work = work.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    (_match, alt: string, url: string) => {
      const src = safeImageSrc(url);
      if (src === null) return stash(escapeHtml(alt));
      return stash(
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async" />`,
      );
    },
  );

  // HQ knowledge uses Obsidian-style wikilinks extensively. The desktop does
  // not yet expose a canonical ontology router, so render the human label
  // cleanly instead of leaking `[[path|label]]` syntax or inventing a broken
  // navigation target.
  work = work.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (_match, target: string, explicitLabel: string | undefined) => {
      const cleanTarget = target.trim();
      const fallbackLabel =
        cleanTarget.split("/").filter(Boolean).at(-1) ?? cleanTarget;
      const label = explicitLabel?.trim() || fallbackLabel;
      return stash(
        `<span class="markdown-wikilink" title="${escapeHtml(cleanTarget)}">${renderInlineEmphasis(escapeHtml(label))}</span>`,
      );
    },
  );

  work = work.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    (_match, label: string, url: string) => {
      const href = safeHref(url);
      const inner = renderInlineEmphasis(escapeHtml(label));
      if (href === null) return stash(inner);
      return stash(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`,
      );
    },
  );

  // CommonMark-style URL/email autolinks. Any other angle-bracket input is
  // escaped below as source text.
  work = work.replace(
    /<(https?:\/\/[^ >]+|mailto:[^ >]+)>/gi,
    (_match, url: string) => {
      const href = safeHref(url);
      if (href === null) return stash(escapeHtml(url));
      return stash(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`,
      );
    },
  );
  work = work.replace(
    /<([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>/gi,
    (_match, address: string) =>
      stash(
        `<a href="mailto:${escapeHtml(address)}" target="_blank" rel="noopener noreferrer">${escapeHtml(address)}</a>`,
      ),
  );

  // Suppress all remaining tag-shaped source instead of displaying literal
  // HTML. The pattern requires whitespace or `>` after the tag name, so
  // CommonMark autolinks such as <https://example.com> are not mistaken for
  // elements.
  work = work.replace(/<\/?[a-z][a-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>/gi, "");

  work = renderInlineEmphasis(escapeHtml(work));
  // Link labels may themselves contain an earlier stashed fragment (for
  // example [`hq setup`](https://example.com)). Restore until stable so a
  // nested code span never leaks a literal "FRAGMENT0" token into the UI.
  let restored = work;
  for (let depth = 0; depth <= fragments.length; depth += 1) {
    const next = restored.replace(
      /\u0000FRAGMENT(\d+)\u0000/g,
      (_match, index: string) => fragments[Number(index)] ?? "",
    );
    if (next === restored) break;
    restored = next;
  }
  return restored;
}

/** Apply bold and italic (asterisk or underscore) to already-escaped text. */
function renderInlineEmphasis(escaped: string): string {
  return escaped
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\b_\b/g, "_") // leave bare underscores in identifiers alone
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
}

/** Split a GFM table row without treating escaped/code/wikilink pipes as columns. */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let escaped = false;
  let codeTicks = 0;
  let inWikilink = false;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (escaped) {
      cell += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (body[index + run] === "`") run += 1;
      codeTicks = codeTicks === run ? 0 : run;
      cell += "`".repeat(run);
      index += run - 1;
      continue;
    }
    if (codeTicks === 0 && character === "[" && body[index + 1] === "[") {
      inWikilink = true;
      cell += "[[";
      index += 1;
      continue;
    }
    if (
      codeTicks === 0 &&
      inWikilink &&
      character === "]" &&
      body[index + 1] === "]"
    ) {
      inWikilink = false;
      cell += "]]";
      index += 1;
      continue;
    }
    if (character === "|" && codeTicks === 0 && !inWikilink) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

type TableAlignment = "left" | "center" | "right" | null;

function tableAlignments(line: string): TableAlignment[] | null {
  if (!line.includes("|")) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))) return null;
    const compact = cell.replace(/\s/g, "");
    alignments.push(
      compact.startsWith(":") && compact.endsWith(":")
        ? "center"
        : compact.endsWith(":")
          ? "right"
          : compact.startsWith(":")
            ? "left"
            : null,
    );
  }
  return alignments;
}

function renderTableCell(
  tag: "th" | "td",
  content: string,
  alignment: TableAlignment,
): string {
  const className = alignment ? ` class="markdown-align-${alignment}"` : "";
  const scope = tag === "th" ? ' scope="col"' : "";
  return `<${tag}${scope}${className}>${renderInline(content)}</${tag}>`;
}

function renderParagraph(lines: string[]): string {
  const content = lines
    .map((line, index) => {
      const hardBreak = /(?: {2,}|\\)$/.test(line);
      const clean = hardBreak ? line.replace(/(?: {2,}|\\)$/, "") : line;
      const separator =
        index === lines.length - 1 ? "" : hardBreak ? "<br />" : " ";
      return `${renderInline(clean.trim())}${separator}`;
    })
    .join("");
  return `<p>${content}</p>`;
}

interface RawHtmlContainer {
  attributes: RawHtmlAttributes;
  body: string;
  nextIndex: number;
}

/**
 * Consume a complete line-oriented HTML container. Incomplete containers fall
 * back to ordinary escaped/suppressed text rather than swallowing the document.
 */
function consumeRawHtmlContainer(
  lines: string[],
  startIndex: number,
  tag: "p" | "div" | "details",
): RawHtmlContainer | null {
  const opening = lines[startIndex].match(
    new RegExp(`^\\s*<${tag}(?=\\s|>)([^>]*)>([\\s\\S]*)$`, "i"),
  );
  if (!opening) return null;

  const closing = new RegExp(`<\\/${tag}\\s*>`, "i");
  const body: string[] = [];
  let index = startIndex;
  let remainder = opening[2];

  while (index < lines.length) {
    const closeAt = remainder.search(closing);
    if (closeAt >= 0) {
      body.push(remainder.slice(0, closeAt));
      return {
        attributes: parseRawHtmlAttributes(opening[1]),
        body: body.join("\n"),
        nextIndex: index + 1,
      };
    }
    body.push(remainder);
    index += 1;
    remainder = lines[index] ?? "";
  }

  return null;
}

function rawAlignment(
  attributes: RawHtmlAttributes,
): "left" | "center" | "right" | null {
  const alignment = attributes.get("align")?.trim().toLowerCase();
  return alignment === "left" || alignment === "center" || alignment === "right"
    ? alignment
    : null;
}

function suppressUnsafeRawHtmlChunk(source: string): string {
  const codeSpans: string[] = [];
  const protectedSource = source.replace(/(`+)([\s\S]*?)\1/g, (code) => {
    const index = codeSpans.push(code) - 1;
    return `\u0000RAWCODE${index}\u0000`;
  });
  return protectedSource
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe)(?=\s|>)[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(
      /\u0000RAWCODE(\d+)\u0000/g,
      (_match, index: string) => codeSpans[Number(index)] ?? "",
    );
}

/**
 * Remove active/hidden raw HTML blocks before Markdown tokenization while
 * preserving examples inside inline and fenced code.
 */
function suppressUnsafeRawHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let ordinary: string[] = [];
  let fence: { marker: string; minimumLength: number } | null = null;

  const flushOrdinary = () => {
    if (ordinary.length === 0) return;
    output.push(...suppressUnsafeRawHtmlChunk(ordinary.join("\n")).split("\n"));
    ordinary = [];
  };

  for (const line of lines) {
    if (fence) {
      output.push(line);
      const closingFence = new RegExp(
        `^\\s*${fence.marker}{${fence.minimumLength},}\\s*$`,
      );
      if (closingFence.test(line)) fence = null;
      continue;
    }

    const openingFence = line.match(/^\s*(`{3,}|~{3,})\s*([a-z0-9_+-]*)\s*$/i);
    if (openingFence) {
      flushOrdinary();
      output.push(line);
      fence = {
        marker: openingFence[1][0],
        minimumLength: openingFence[1].length,
      };
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      flushOrdinary();
      output.push(line);
      continue;
    }

    ordinary.push(line);
  }

  flushOrdinary();
  return output.join("\n");
}

interface ListMarker {
  indent: number;
  ordered: boolean;
  content: string;
}

function listMarker(line: string): ListMarker | null {
  const match = line.match(/^([ \t]*)([-*+]|\d+\.)\s+(.*)$/);
  if (!match) return null;
  const indent = [...match[1]].reduce(
    (columns, character) => columns + (character === "\t" ? 4 : 1),
    0,
  );
  return {
    indent,
    ordered: /^\d+\.$/.test(match[2]),
    content: match[3],
  };
}

function renderListItem(
  contentLines: string[],
  nested: string[],
): { html: string; task: boolean } {
  const content = contentLines.join(" ").trim();
  const task = content.match(/^\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = task[1].toLowerCase() === "x" ? " checked" : "";
    return {
      html: `<li class="task-list-item"><input type="checkbox" disabled${checked} /><div class="task-list-content"><span>${renderInline(task[2])}</span>${nested.join("")}</div></li>`,
      task: true,
    };
  }
  return {
    html: `<li>${renderInline(content)}${nested.join("")}</li>`,
    task: false,
  };
}

/**
 * Render one list level and return the first unconsumed line. Indented child
 * lists recurse; indented/lazy continuation lines stay in their parent item.
 */
function renderListBlock(
  lines: string[],
  startIndex: number,
): { html: string; nextIndex: number } {
  const first = listMarker(lines[startIndex]);
  if (!first) return { html: "", nextIndex: startIndex };

  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: string[] = [];
  let hasTask = false;
  let index = startIndex;

  while (index < lines.length) {
    const marker = listMarker(lines[index]);
    if (!marker || marker.indent !== baseIndent || marker.ordered !== ordered)
      break;

    const contentLines = [marker.content];
    const nested: string[] = [];
    index += 1;

    while (index < lines.length) {
      const candidate = listMarker(lines[index]);
      if (candidate) {
        if (candidate.indent === baseIndent) break;
        if (candidate.indent < baseIndent) break;
        const child = renderListBlock(lines, index);
        nested.push(child.html);
        index = child.nextIndex;
        continue;
      }

      if (lines[index].trim() === "") {
        const next =
          index + 1 < lines.length ? listMarker(lines[index + 1]) : null;
        if (next && next.indent >= baseIndent) {
          index += 1;
          continue;
        }
        break;
      }

      const indentation = lines[index].match(/^[ \t]*/)?.[0] ?? "";
      const columns = [...indentation].reduce(
        (total, character) => total + (character === "\t" ? 4 : 1),
        0,
      );
      // An indented continuation is unambiguously part of the item. CommonMark
      // also permits a non-indented "lazy" continuation until a blank line.
      if (
        columns > baseIndent ||
        !/^\s*(?:#{1,6}\s|>|```|~~~)/.test(lines[index])
      ) {
        contentLines.push(lines[index].trim());
        index += 1;
        continue;
      }
      break;
    }

    const rendered = renderListItem(contentLines, nested);
    hasTask ||= rendered.task;
    items.push(rendered.html);
  }

  const tag = ordered ? "ol" : "ul";
  const taskClass = hasTask ? ' class="task-list"' : "";
  return {
    html: `<${tag}${taskClass}>${items.join("")}</${tag}>`,
    nextIndex: index,
  };
}

/**
 * Render a full Markdown document to a safe HTML string.
 *
 * Block grammar handled line-by-line: fenced code blocks, ATX headings, unordered
 * and ordered lists, blockquotes, horizontal rules, and paragraphs. Anything not
 * matched flows into a paragraph of inline-rendered (escaped) text.
 */
function renderMarkdownCore(source: string): string {
  const lines = suppressUnsafeRawHtml(source).split("\n");
  const out: string[] = [];

  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(renderParagraph(paragraph));
    paragraph = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const isIndentedCode = /^(?: {4}|\t)/.test(line);

    // Common README alignment wrapper. The container and its attributes are
    // rebuilt; arbitrary classes, styles, and event handlers are discarded.
    const rawParagraph = isIndentedCode
      ? null
      : (consumeRawHtmlContainer(lines, i, "p") ??
        consumeRawHtmlContainer(lines, i, "div"));
    if (rawParagraph) {
      flushParagraph();
      const alignment = rawAlignment(rawParagraph.attributes);
      const className = alignment ? ` class="markdown-align-${alignment}"` : "";
      const content = rawParagraph.body
        .split("\n")
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ");
      out.push(`<p${className}>${renderInline(content)}</p>`);
      i = rawParagraph.nextIndex;
      continue;
    }

    // README disclosure block. Only the boolean `open` state survives; summary
    // contents and the body return through the safe inline/block renderers.
    const rawDetails = isIndentedCode
      ? null
      : consumeRawHtmlContainer(lines, i, "details");
    if (rawDetails) {
      flushParagraph();
      const summary = rawDetails.body.match(
        /^\s*<summary(?=\s|>)[^>]*>([\s\S]*?)<\/summary\s*>/i,
      );
      const summaryHtml = summary
        ? `<summary>${renderInline(summary[1].trim())}</summary>`
        : "";
      const detailsBody = (
        summary ? rawDetails.body.slice(summary[0].length) : rawDetails.body
      ).trim();
      const bodyHtml = detailsBody ? renderMarkdownCore(detailsBody) : "";
      const open = rawDetails.attributes.has("open") ? " open" : "";
      out.push(`<details${open}>${summaryHtml}${bodyHtml}</details>`);
      i = rawDetails.nextIndex;
      continue;
    }

    // Fenced code block: ``` / ~~~, with an optional safe language class.
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([a-z0-9_+-]*)\s*$/i);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      const marker = fence[1][0];
      const minimumLength = fence[1].length;
      i += 1;
      const closingFence = new RegExp(`^\\s*${marker}{${minimumLength},}\\s*$`);
      while (i < lines.length && !closingFence.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const language = fence[2]
        ? ` class="language-${escapeHtml(fence[2].toLowerCase())}"`
        : "";
      out.push(
        `<pre><code${language}>${escapeHtml(body.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // Four-space indented code block.
    if (/^(?: {4}|\t)/.test(line)) {
      flushParagraph();
      const body: string[] = [];
      while (
        i < lines.length &&
        (/^(?: {4}|\t)/.test(lines[i]) || lines[i] === "")
      ) {
        body.push(lines[i].replace(/^(?: {4}|\t)/, ""));
        i += 1;
      }
      while (body.at(-1) === "") body.pop();
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1\1[-*_\s]*$/.test(line) && line.trim().length >= 3) {
      flushParagraph();
      out.push("<hr />");
      i += 1;
      continue;
    }

    // ATX heading.
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Setext heading.
    if (
      i + 1 < lines.length &&
      line.trim() !== "" &&
      /^\s*(=+|-+)\s*$/.test(lines[i + 1])
    ) {
      flushParagraph();
      const level = lines[i + 1].trim().startsWith("=") ? 1 : 2;
      out.push(`<h${level}>${renderInline(line.trim())}</h${level}>`);
      i += 2;
      continue;
    }

    // GFM table: header row followed by a delimiter row.
    const alignments =
      i + 1 < lines.length ? tableAlignments(lines[i + 1]) : null;
    if (line.includes("|") && alignments) {
      flushParagraph();
      const headers = splitTableRow(line);
      if (headers.length !== alignments.length) {
        paragraph.push(line);
        i += 1;
        continue;
      }
      const width = headers.length;
      const normalizedAlignments = Array.from(
        { length: width },
        (_, column) => alignments[column] ?? null,
      );
      const headerHtml = Array.from({ length: width }, (_, column) =>
        renderTableCell(
          "th",
          headers[column] ?? "",
          normalizedAlignments[column],
        ),
      ).join("");
      i += 2;
      const rows: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        lines[i].includes("|")
      ) {
        const cells = splitTableRow(lines[i]);
        rows.push(
          `<tr>${Array.from({ length: width }, (_, column) =>
            renderTableCell(
              "td",
              cells[column] ?? "",
              normalizedAlignments[column],
            ),
          ).join("")}</tr>`,
        );
        i += 1;
      }
      out.push(
        `<div class="markdown-table-scroll" tabindex="0"><table><thead><tr>${headerHtml}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      );
      continue;
    }

    // Blockquote (consume consecutive `>` lines).
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      out.push(
        `<blockquote>${renderMarkdownCore(quote.join("\n"))}</blockquote>`,
      );
      continue;
    }

    // Lists (unordered or ordered) — consume the contiguous block.
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushParagraph();
      const list = renderListBlock(lines, i);
      out.push(list.html);
      i = list.nextIndex;
      continue;
    }

    // Blank line → paragraph boundary.
    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    // Otherwise accumulate into the current paragraph.
    // Preserve trailing spaces/backslashes until renderParagraph resolves hard
    // line breaks; only leading document indentation is discarded here.
    paragraph.push(line.trimStart());
    i += 1;
  }

  flushParagraph();
  return out.join("\n");
}

/**
 * Render arbitrary Markdown without treating a YAML-shaped prefix as hidden
 * metadata. Messages and recursive blocks use this lossless entry point.
 */
export function renderMarkdown(source: string): string {
  return renderMarkdownCore(source);
}

/**
 * Render one top-level HQ file/knowledge document. Frontmatter is removed once
 * at this boundary; nested quotes and disclosure bodies remain ordinary text.
 */
export function renderMarkdownDocument(source: string): string {
  return renderMarkdownCore(withoutYamlFrontmatter(source));
}
