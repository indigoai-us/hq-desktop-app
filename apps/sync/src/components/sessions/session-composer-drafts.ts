/**
 * Unsent new-session composer drafts. Kept in-process so back/forward remounts
 * restore text and images. Prompt text is never stored in navigation history.
 */
import type { ComposerImage } from './session-models';

export interface SessionComposerDraft {
  text: string;
  images: ComposerImage[];
}

const drafts = new Map<string, SessionComposerDraft>();

function cloneDraft(draft: SessionComposerDraft): SessionComposerDraft {
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
  };
}

export function loadSessionComposerDraft(
  key: string | null | undefined,
): SessionComposerDraft {
  if (!key) return { text: '', images: [] };
  const stored = drafts.get(key);
  return stored ? cloneDraft(stored) : { text: '', images: [] };
}

export function saveSessionComposerDraft(
  key: string | null | undefined,
  draft: SessionComposerDraft,
): boolean {
  if (!key) return false;
  if (!draft.text.trim() && draft.images.length === 0) {
    drafts.delete(key);
    return true;
  }
  drafts.set(key, cloneDraft(draft));
  return true;
}

export function clearSessionComposerDraft(key: string | null | undefined): boolean {
  if (!key) return false;
  drafts.delete(key);
  return true;
}

export function resetSessionComposerDraftsForTests(): void {
  drafts.clear();
}
