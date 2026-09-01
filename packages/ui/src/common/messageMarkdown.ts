/**
 * Message-body Markdown rendering (ported from hq-sync `lib/messageMarkdown`).
 *
 * Channel/DM bodies render through the same CSP-safe `renderMarkdown` used for
 * knowledge documents, but WITHOUT frontmatter stripping (a message that starts
 * with `---` is ordinary content, not metadata). Transport/template layers
 * sometimes indent an entire rich message; `normalizeMessageMarkdown` treats a
 * shared document indent as framing rather than an implicit code block, so
 * lists, headings, and links survive. Deliberate code should use a fence, which
 * is never touched here.
 */
import { escapeHtml, renderMarkdown, safeHref } from "./markdown.js";

function trimBlankBoundaryLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim().length === 0) start += 1;
  while (end > start && lines[end - 1].trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

function removeIndent(line: string, columns: number): string {
  let consumed = 0;
  let index = 0;
  while (index < line.length && consumed < columns) {
    if (line[index] === " ") {
      consumed += 1;
      index += 1;
    } else if (line[index] === "\t") {
      consumed += 4;
      index += 1;
    } else {
      break;
    }
  }
  return line.slice(index);
}

/**
 * Dedent only a recognisable multi-block Markdown document. Four-space
 * indentation is valid Markdown code, so common whitespace alone is never
 * enough evidence that a transport/template added framing.
 */
function looksTransportFramed(lines: string[], commonIndent: number): boolean {
  if (commonIndent <= 0) return false;
  const stripped = trimBlankBoundaryLines(
    lines.map((line) => removeIndent(line, commonIndent)),
  );
  const nonEmpty = stripped.filter((line) => line.trim().length > 0);
  if (nonEmpty.length < 2) return false;

  const first = nonEmpty[0].trim();
  const last = nonEmpty[nonEmpty.length - 1].trim();
  if (/^(```|~~~)/.test(first) && last.startsWith(first.slice(0, 3))) {
    return true;
  }

  const hasInternalBlankLine = stripped
    .slice(1, -1)
    .some((line) => line.trim().length === 0);
  if (!hasInternalBlankLine) return false;

  const blockCues = nonEmpty.filter((line) =>
    /^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|~~~|\|.*\||(?:---+|\*\*\*+|___+)\s*$)/.test(
      line.trim(),
    ),
  ).length;
  return blockCues >= 2;
}

/**
 * Transport/template layers sometimes indent an entire rich message. Treat
 * shared document indentation as framing rather than an implicit code block;
 * deliberate code in messages should use a Markdown fence, which remains
 * untouched after this normalization.
 */
export function normalizeMessageMarkdown(body: string): string {
  const normalized = body.replace(/\r\n?/g, "\n");
  const lines = trimBlankBoundaryLines(normalized.split("\n"));
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return "";

  const commonIndent = Math.min(
    ...nonEmpty.map((line) => {
      const indentation = line.match(/^[ \t]*/)?.[0] ?? "";
      return [...indentation].reduce(
        (columns, character) => columns + (character === "\t" ? 4 : 1),
        0,
      );
    }),
  );
  if (!looksTransportFramed(lines, commonIndent)) return lines.join("\n");

  return lines
    .map((line) => removeIndent(line, commonIndent))
    .join("\n")
    .trimEnd();
}

/** Render a channel/DM message body to safe HTML (no frontmatter stripping). */
const MARKDOWN_CACHE_LIMIT = 200;
const markdownCache = new Map<string, string>();

/** Full Markdown on agent log/JSON dumps freezes the click loop. */
export const MESSAGE_MARKDOWN_MAX_CHARS = 1_200;

export function isHeavyMessageBody(body: string): boolean {
  const text = body.trim();
  if (text.length > MESSAGE_MARKDOWN_MAX_CHARS) return true;
  if (text.length > 400 && (text.startsWith("{") || text.startsWith("["))) {
    return true;
  }
  const lines = text.split("\n");
  if (lines.length > 30) {
    const markdownCues = lines.filter((line) =>
      /^(?:#{1,6}\s+|```|~~~|[-*+]\s+|\d+[.)]\s+|>\s+)/.test(line.trim()),
    ).length;
    return markdownCues < 2;
  }
  return false;
}

/** Clip heavy bodies so 20–40 bubbles cannot freeze the click loop / a11y tree. */
export const MESSAGE_PLAIN_DISPLAY_CHARS = 500;

export function clipMessageBodyForDisplay(body: string): string {
  if (body.length <= MESSAGE_PLAIN_DISPLAY_CHARS) return body;
  return `${body.slice(0, MESSAGE_PLAIN_DISPLAY_CHARS)}\n…`;
}

function renderPlainMessageBody(body: string): string {
  return `<pre class="dm-plain">${escapeHtml(clipMessageBodyForDisplay(body))}</pre>`;
}

function tagName(tag: string): { name: string; closing: boolean } | null {
  const match = tag.match(/^<\/?([A-Za-z][A-Za-z0-9]*)/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), closing: tag.startsWith("</") };
}

/** Strip sentence punctuation and an unmatched trailing `)` from a URL match. */
function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const withoutPunct = url.replace(/[.,;:!?]+$/, "");
    let next = withoutPunct;
    if (next.endsWith(")")) {
      let open = 0;
      let close = 0;
      for (const character of next) {
        if (character === "(") open += 1;
        else if (character === ")") close += 1;
      }
      if (close > open) next = next.slice(0, -1);
    }
    if (next === url) return next;
    url = next;
  }
}

function autolinkUrlsInText(text: string): string {
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  return text.replace(pattern, (raw) => {
    const url = trimBareUrl(raw);
    if (url.length === 0) return raw;
    if (safeHref(url) === null) return raw;
    if (!/^https?:/i.test(url)) return raw;
    const suffix = raw.slice(url.length);
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${suffix}`;
  });
}

/**
 * Wrap bare http(s) URLs in already-rendered HTML. Only text outside tags is
 * scanned, and `<code>` / `<pre>` / `<a>` contents are skipped. Matched text is
 * already escaped; this only wraps it — it never decodes entities or
 * interpolates raw input.
 */
export function autolinkMessageUrls(html: string): string {
  if (!/https?:\/\//i.test(html)) return html;

  let out = "";
  let cursor = 0;
  let codeDepth = 0;
  let preDepth = 0;
  let aDepth = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const text = html.slice(cursor, textEnd);
    const skip = codeDepth > 0 || preDepth > 0 || aDepth > 0;
    out += skip ? text : autolinkUrlsInText(text);
    if (tagStart === -1) break;

    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    const parsed = tagName(tag);
    out += tag;
    if (
      parsed &&
      (parsed.name === "code" || parsed.name === "pre" || parsed.name === "a")
    ) {
      const selfClosing = /\/\s*>$/.test(tag);
      if (!selfClosing) {
        const delta = parsed.closing ? -1 : 1;
        if (parsed.name === "code") {
          codeDepth = Math.max(0, codeDepth + delta);
        } else if (parsed.name === "pre") {
          preDepth = Math.max(0, preDepth + delta);
        } else {
          aDepth = Math.max(0, aDepth + delta);
        }
      }
    }
    cursor = tagEnd + 1;
  }

  return out;
}

export function renderMessageBodyMarkdown(body: string): string {
  const hit = markdownCache.get(body);
  if (hit !== undefined) return hit;
  const html = autolinkMessageUrls(
    isHeavyMessageBody(body)
      ? renderPlainMessageBody(body)
      : renderMarkdown(normalizeMessageMarkdown(body)),
  );
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
    const first = markdownCache.keys().next().value;
    if (first !== undefined) markdownCache.delete(first);
  }
  markdownCache.set(body, html);
  return html;
}
