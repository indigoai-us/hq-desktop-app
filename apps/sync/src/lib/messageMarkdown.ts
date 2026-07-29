import { renderMarkdown } from './markdown';

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

export function renderMessageBodyMarkdown(body: string): string {
  return renderMarkdown(normalizeMessageMarkdown(body));
}
