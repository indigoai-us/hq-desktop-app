import { renderMarkdown, safeHref } from './markdown';
import { replaceEmojiShortcodesInHtml } from './emojiShortcodes';

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
    if (line[index] === ' ') {
      consumed += 1;
      index += 1;
    } else if (line[index] === '\t') {
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
  const normalized = body.replace(/\r\n?/g, '\n');
  const lines = trimBlankBoundaryLines(normalized.split('\n'));
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  const commonIndent = Math.min(
    ...nonEmpty.map((line) => {
      const indentation = line.match(/^[ \t]*/)?.[0] ?? '';
      return [...indentation].reduce(
        (columns, character) => columns + (character === '\t' ? 4 : 1),
        0,
      );
    }),
  );
  if (!looksTransportFramed(lines, commonIndent)) return lines.join('\n');

  return lines
    .map((line) => removeIndent(line, commonIndent))
    .join('\n')
    .trimEnd();
}

const FENCE_LINE = /^\s*(`{3,}|~{3,})\s*([a-z0-9_+-]*)\s*$/i;

function fenceOpen(line: string): { marker: string; minimumLength: number } | null {
  const match = line.match(FENCE_LINE);
  if (!match) return null;
  return { marker: match[1][0], minimumLength: match[1].length };
}

/** True for Markdown block lines we must not rewrite as chat hard-breaks. */
function isBlockMarkdownLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (FENCE_LINE.test(line)) return true;
  if (/^(?: {4}|\t)/.test(line)) return true;
  if (/^#{1,6}\s/.test(trimmed)) return true;
  if (/^[-*+]\s+/.test(trimmed)) return true;
  if (/^\d+[.)]\s+/.test(trimmed)) return true;
  if (trimmed.startsWith('>')) return true;
  if (trimmed.includes('|')) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,}|=+)\s*$/.test(trimmed)) return true;
  return false;
}

function isPlainParagraphLine(line: string): boolean {
  return line.trim().length > 0 && !isBlockMarkdownLine(line);
}

function withHardBreakSuffix(line: string): string {
  if (/(?: {2,}|\\)$/.test(line)) return line;
  return `${line}  `;
}

/**
 * Chat convention: a single newline inside a plain paragraph is a line break,
 * not a space. Append Markdown's two-space hard-break suffix to plain-text
 * lines that are followed by another plain non-blank line. Fenced code and
 * other block constructs are left untouched.
 */
export function applyChatLineBreaks(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: { marker: string; minimumLength: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      out.push(line);
      const closing = new RegExp(
        `^\\s*${fence.marker}{${fence.minimumLength},}\\s*$`,
      );
      if (closing.test(line)) fence = null;
      continue;
    }

    const opening = fenceOpen(line);
    if (opening) {
      fence = opening;
      out.push(line);
      continue;
    }

    const next = lines[index + 1];
    if (
      next !== undefined &&
      isPlainParagraphLine(line) &&
      isPlainParagraphLine(next)
    ) {
      out.push(withHardBreakSuffix(line));
    } else {
      out.push(line);
    }
  }

  return out.join('\n');
}

function wrapMentionsInText(text: string): string {
  if (!text.includes('@')) return text;
  // Fresh regex each call so a global lastIndex cannot leak across segments.
  const pattern =
    /(^|[^A-Za-z0-9_])(@[A-Za-z](?:[A-Za-z0-9._'-]|&#39;)*(?: [A-Z](?:[A-Za-z0-9._'-]|&#39;)*){0,1})/g;
  return text.replace(
    pattern,
    (_match, prefix: string, mention: string) =>
      `${prefix}<span class="message-mention">${mention}</span>`,
  );
}

function tagName(tag: string): { name: string; closing: boolean } | null {
  const match = tag.match(/^<\/?([A-Za-z][A-Za-z0-9]*)/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), closing: tag.startsWith('</') };
}

/** Strip sentence punctuation and an unmatched trailing `)` from a URL match. */
function trimBareUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const withoutPunct = url.replace(/[.,;:!?]+$/, '');
    let next = withoutPunct;
    if (next.endsWith(')')) {
      let open = 0;
      let close = 0;
      for (const character of next) {
        if (character === '(') open += 1;
        else if (character === ')') close += 1;
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
 * Wrap @mentions in already-rendered HTML. Only text outside tags is scanned,
 * and `<code>` / `<pre>` contents are skipped. Matched text is already escaped;
 * this only wraps it — it never decodes entities or interpolates raw input.
 */
export function wrapMessageMentions(html: string): string {
  if (!html.includes('@')) return html;

  let out = '';
  let cursor = 0;
  let codeDepth = 0;
  let preDepth = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const text = html.slice(cursor, textEnd);
    out += codeDepth > 0 || preDepth > 0 ? text : wrapMentionsInText(text);
    if (tagStart === -1) break;

    const tagEnd = html.indexOf('>', tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    const parsed = tagName(tag);
    out += tag;
    if (parsed && (parsed.name === 'code' || parsed.name === 'pre')) {
      const selfClosing = /\/\s*>$/.test(tag);
      if (!selfClosing) {
        const delta = parsed.closing ? -1 : 1;
        if (parsed.name === 'code') {
          codeDepth = Math.max(0, codeDepth + delta);
        } else {
          preDepth = Math.max(0, preDepth + delta);
        }
      }
    }
    cursor = tagEnd + 1;
  }

  return out;
}

/**
 * Wrap bare http(s) URLs in already-rendered HTML. Only text outside tags is
 * scanned, and `<code>` / `<pre>` / `<a>` contents are skipped. Matched text is
 * already escaped; this only wraps it — it never decodes entities or
 * interpolates raw input.
 */
export function autolinkMessageUrls(html: string): string {
  if (!/https?:\/\//i.test(html)) return html;

  let out = '';
  let cursor = 0;
  let codeDepth = 0;
  let preDepth = 0;
  let aDepth = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    const textEnd = tagStart === -1 ? html.length : tagStart;
    const text = html.slice(cursor, textEnd);
    const skip = codeDepth > 0 || preDepth > 0 || aDepth > 0;
    out += skip ? text : autolinkUrlsInText(text);
    if (tagStart === -1) break;

    const tagEnd = html.indexOf('>', tagStart);
    if (tagEnd === -1) {
      out += html.slice(tagStart);
      break;
    }

    const tag = html.slice(tagStart, tagEnd + 1);
    const parsed = tagName(tag);
    out += tag;
    if (
      parsed &&
      (parsed.name === 'code' || parsed.name === 'pre' || parsed.name === 'a')
    ) {
      const selfClosing = /\/\s*>$/.test(tag);
      if (!selfClosing) {
        const delta = parsed.closing ? -1 : 1;
        if (parsed.name === 'code') {
          codeDepth = Math.max(0, codeDepth + delta);
        } else if (parsed.name === 'pre') {
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
  const markdown = applyChatLineBreaks(normalizeMessageMarkdown(body));
  // Emoji conversion runs on already-escaped HTML after autolinking + mention
  // wrapping, so <a>/<code>/<pre> contents (URLs, code spans, fences) and the
  // tags themselves are never rewritten.
  return replaceEmojiShortcodesInHtml(
    wrapMessageMentions(autolinkMessageUrls(renderMarkdown(markdown))),
  );
}
