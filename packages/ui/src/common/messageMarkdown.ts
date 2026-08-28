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
import { escapeHtml, renderMarkdown } from "./markdown.js";

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

export function renderMessageBodyMarkdown(body: string): string {
  const hit = markdownCache.get(body);
  if (hit !== undefined) return hit;
  const html = isHeavyMessageBody(body)
    ? renderPlainMessageBody(body)
    : renderMarkdown(normalizeMessageMarkdown(body));
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
    const first = markdownCache.keys().next().value;
    if (first !== undefined) markdownCache.delete(first);
  }
  markdownCache.set(body, html);
  return html;
}
