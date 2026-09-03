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
