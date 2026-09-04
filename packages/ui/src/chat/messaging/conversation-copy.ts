/**
 * Clipboard text for conversation bubbles.
 * A message can offer the visible body (plus details) or the attached agent
 * prompt (`hq dm --prompt`). Empty → null so the caller skips the write.
 *
 * Preview/truncation lives in `artifact-model.ts` — long artifacts are never
 * clipped with a bare ellipsis any more, they open in the side pane.
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
