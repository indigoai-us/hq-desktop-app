/**
 * Clipboard text + prompt preview for conversation bubbles.
 * A message can offer the visible body (plus details) or the attached agent
 * prompt (`hq dm --prompt`). Empty → null so the caller skips the write.
 */

export type CopyKind = "body" | "prompt" | "details";

export interface CopyableMessage {
  body?: string | null;
  details?: string | null;
  prompt?: string | null;
}

export function copyableText(
  msg: CopyableMessage,
  kind: CopyKind,
): string | null {
  if (kind === "prompt") {
    const trimmed = msg.prompt?.trim();
    return trimmed ? trimmed : null;
  }
  if (kind === "details") {
    const trimmed = msg.details?.trim();
    return trimmed ? trimmed : null;
  }
  const parts = [msg.body, msg.details]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length ? parts.join("\n\n") : null;
}

/** Short preview for the highlighted prompt card. */
export function promptPreview(text: string, max = 180): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  const slice = lastBreak > 80 ? cut.slice(0, lastBreak) : cut;
  return `${slice.trimEnd()}…`;
}
