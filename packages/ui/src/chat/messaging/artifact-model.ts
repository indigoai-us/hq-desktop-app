/**
 * Chat artifact model — the structured long blocks (`hq dm --details` /
 * `--prompt`, delegation/handoff cards) that used to be hard-clamped to 180
 * characters with a bare "…" and no way to read the rest.
 *
 * Pure helpers only: title / size hint / faded preview lines. The card renders
 * these; the side pane renders `text` in full.
 */

export type ArtifactKind = "prompt" | "details";

export interface ChatArtifact {
  /** Stable pane identity: event + kind. */
  id: string;
  kind: ArtifactKind;
  /** "Prompt" / "Details" — the type label shown next to the title. */
  kindLabel: string;
  /** The artifact's own title, or a derived first-line summary. */
  title: string;
  /** Full, untruncated content. */
  text: string;
  lineCount: number;
  charCount: number;
  /** e.g. "42 lines · 1.8k chars". */
  sizeLabel: string;
}

/** Lines shown in the card preview before the fade. */
export const ARTIFACT_PREVIEW_LINES = 6;

const TITLE_MAX = 72;

export function artifactKindLabel(kind: ArtifactKind): string {
  return kind === "details" ? "Details" : "Prompt";
}

function stripTitleMarkup(line: string): string {
  return line
    .replace(/^\s*[#>*\-•]+\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .replace(/[*_`]+/g, "")
    .replace(/[:\s]+$/, "")
    .trim();
}

/**
 * The artifact's own title when it declares one — a leading `TITLE:` / `# Title`
 * line or a filename — otherwise a first-line summary. Never empty.
 */
export function artifactTitle(text: string, kind: ArtifactKind): string {
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const labelled = /^(?:title|subject|re)\s*:\s*(.+)$/i.exec(line);
    const candidate = stripTitleMarkup(labelled ? labelled[1] : line);
    if (!candidate) continue;
    return candidate.length > TITLE_MAX
      ? `${candidate.slice(0, TITLE_MAX - 1).trimEnd()}…`
      : candidate;
  }
  return artifactKindLabel(kind);
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

export function artifactSizeLabel(text: string): string {
  const lines = text.split("\n").length;
  const chars = text.length;
  const lineLabel = `${formatCount(lines)} ${lines === 1 ? "line" : "lines"}`;
  return `${lineLabel} · ${formatCount(chars)} chars`;
}

/**
 * Preview LINES for the card. No ellipsis and no mid-sentence cut marker: the
 * card fades the last line out in CSS and the pane holds the full text.
 */
export function artifactPreviewLines(
  text: string,
  maxLines = ARTIFACT_PREVIEW_LINES,
): string[] {
  const lines = text.replace(/\s+$/, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    if (!line.trim() && kept.length === 0) continue;
    kept.push(line);
  }
  return kept;
}

/**
 * True when the artifact reads as Markdown (headings, lists, fences, tables,
 * emphasis, links, quotes) and should render through the safe Markdown
 * renderer. Plain prose, logs and JSON dumps stay as line-preserving text —
 * a `*` in a log line must not turn into emphasis.
 */
export function artifactLooksLikeMarkdown(text: string): boolean {
  if (/^\s*```/m.test(text)) return true;
  if (/^\s{0,3}#{1,6}\s+\S/m.test(text)) return true;
  if (/^\s{0,3}(?:[-*+]|\d+[.)])\s+\S/m.test(text)) return true;
  if (/^\s{0,3}>\s?\S/m.test(text)) return true;
  if (/^\s{0,3}\|.+\|\s*$/m.test(text)) return true;
  if (/\*\*[^*\n]+\*\*/.test(text)) return true;
  if (/`[^`\n]+`/.test(text)) return true;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(text)) return true;
  return false;
}

/**
 * The artifact body without a leading `# Title` / `TITLE:` line that the card
 * already shows as its title — the preview should start on the first line
 * the header does not repeat. Returns `text` unchanged when the first line is
 * ordinary content.
 */
export function artifactBodyAfterTitle(text: string, kind: ArtifactKind): string {
  const title = artifactTitle(text, kind);
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return text;
  const first = lines[i].trim();
  const isHeading = /^\s{0,3}#{1,6}\s+\S/.test(first);
  const isLabelled = /^(?:title|subject|re)\s*:/i.test(first);
  if (!isHeading && !isLabelled) return text;
  const labelled = /^(?:title|subject|re)\s*:\s*(.+)$/i.exec(first);
  const candidate = stripTitleMarkup(labelled ? labelled[1] : first);
  const shown = title.endsWith("…") ? title.slice(0, -1) : title;
  if (!candidate.startsWith(shown)) return text;
  return lines.slice(i + 1).join("\n").replace(/^\s*\n/, "");
}

/** Inline markdown → plain text for a one-line summary. */
function stripInlineMarkup(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\|?\s*|\s*\|?$/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
}

export const ARTIFACT_SUMMARY_MAX = 160;

/**
 * One-line description for the collapsed card: the first content line after
 * the title, with markdown syntax stripped. Skips fences, rules, and table
 * separator rows. Empty when the artifact is nothing but its title.
 */
export function artifactSummary(text: string, kind: ArtifactKind): string {
  const body = artifactBodyAfterTitle(text, kind);
  // For plain artifacts the title IS the first line; skip it here too.
  const title = artifactTitle(text, kind);
  const shownTitle = title.endsWith("…") ? title.slice(0, -1) : title;
  let seenContent = false;
  let inFence = false;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    if (/^\|?\s*:?-{2,}/.test(line)) continue;
    const plain = stripInlineMarkup(line);
    if (!plain) continue;
    if (!seenContent) {
      seenContent = true;
      if (plain.startsWith(shownTitle)) continue;
    }
    return plain.length > ARTIFACT_SUMMARY_MAX
      ? `${plain.slice(0, ARTIFACT_SUMMARY_MAX - 1).trimEnd()}…`
      : plain;
  }
  return "";
}

export function artifactPreview(text: string, maxLines?: number): string {
  return artifactPreviewLines(text, maxLines).join("\n");
}

/** True when the card preview shows less than the whole artifact. */
export function artifactHasMore(text: string, maxLines?: number): boolean {
  return artifactPreview(text, maxLines).trim() !== text.trim();
}

export function chatArtifact(args: {
  text: string;
  eventId: string;
  kind: ArtifactKind;
}): ChatArtifact {
  const text = args.text.replace(/\s+$/, "");
  return {
    id: `${args.eventId}:${args.kind}`,
    kind: args.kind,
    kindLabel: artifactKindLabel(args.kind),
    title: artifactTitle(text, args.kind),
    text,
    lineCount: text.split("\n").length,
    charCount: text.length,
    sizeLabel: artifactSizeLabel(text),
  };
}
