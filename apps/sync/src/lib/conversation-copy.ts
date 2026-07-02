// Pure clipboard-text resolver for conversation bubbles. A message can offer
// two copy actions: the whole message body, and (when present) the attached
// agent prompt delivered via `hq dm --prompt`. Keeping the selection logic here
// — trimmed, with empty → null so the caller no-ops — lets it be unit-tested
// without a DOM (the Svelte component just calls navigator.clipboard with the
// result).

export type CopyKind = 'body' | 'prompt';

export interface CopyableMessage {
  body: string;
  // Block-formatted content rendered below the body (e.g. `hq dm --details`).
  // A "Copy message" action must include it — copying only `body` silently
  // drops everything the user can see in the bubble (feedback DEV-1835).
  details?: string | null;
  prompt?: string | null;
}

/**
 * Resolve the text to put on the clipboard for a given copy action.
 *
 * For a `body` copy we return the FULL visible message — the body plus any
 * block-formatted `details` beneath it, joined by a blank line so the copied
 * text mirrors what's shown on screen. (Copying only the top-level body was
 * DEV-1835: block-formatted messages lost their details on copy.)
 *
 * Returns null when there's nothing meaningful to copy (empty/whitespace, or a
 * prompt copy on a message that carries no prompt) so the caller can skip the
 * clipboard write and the "Copied!" feedback.
 */
export function copyableText(msg: CopyableMessage, kind: CopyKind): string | null {
  if (kind === 'prompt') {
    const trimmed = msg.prompt?.trim();
    return trimmed ? trimmed : null;
  }
  // 'body' → the whole visible message: body + block-formatted details.
  const parts = [msg.body, msg.details]
    .map((part) => part?.trim())
    .filter((part): part is string => !!part);
  return parts.length ? parts.join('\n\n') : null;
}
