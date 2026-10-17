/**
 * Unsent thread composer text and attachments for this app session.
 * Keyed per thread so closing the sidebar does not throw the draft away,
 * and reopening that thread restores it. Cleared on send, and gone when
 * the page reloads.
 */

export interface ThreadComposerDraft {
  text: string;
  files: readonly File[];
}

const drafts = new Map<string, ThreadComposerDraft>();

export function threadComposerDraftKey(input: {
  scope: string;
  channelId?: string | null;
  withPersonUid?: string | null;
  rootEventId: string;
}): string {
  const conversation =
    input.scope === "dm"
      ? (input.withPersonUid ?? "").trim()
      : (input.channelId ?? "").trim();
  return `${input.scope}:${conversation}:${input.rootEventId.trim()}`;
}

export function readThreadComposerDraft(
  key: string,
): ThreadComposerDraft | null {
  return drafts.get(key) ?? null;
}

export function writeThreadComposerDraft(
  key: string,
  draft: { text: string; files: readonly File[] },
): void {
  const text = draft.text;
  const files = draft.files.filter((file) => file instanceof File);
  if (!text && files.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, { text, files: [...files] });
}

export function clearThreadComposerDraft(key: string): void {
  drafts.delete(key);
}

/** Test isolation. Not a user-facing reset. */
export function resetThreadComposerDrafts(): void {
  drafts.clear();
}
