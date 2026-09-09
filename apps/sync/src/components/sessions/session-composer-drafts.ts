/**
 * Unsent new-session composer drafts. Kept in-process so back/forward remounts
 * restore text and images. Prompt text is never stored in navigation history.
 *
 * Keys are namespaced by the signed-in account. Sign-out and account switch
 * drop every draft so another identity cannot restore unsent text or images.
 */
import type { ComposerImage } from './session-models';

export interface SessionComposerDraft {
  text: string;
  images: ComposerImage[];
}

const drafts = new Map<string, SessionComposerDraft>();
let accountId: string | null = null;

function cloneDraft(draft: SessionComposerDraft): SessionComposerDraft {
  return {
    text: draft.text,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function scopedKey(key: string): string {
  return `${accountId ?? ''}\u001f${key}`;
}

/** Bind drafts to the signed-in account. A different account clears the map. */
export function setSessionComposerDraftAccount(
  nextAccountId: string | null | undefined,
): void {
  const next = nextAccountId?.trim() || null;
  if (accountId === next) return;
  drafts.clear();
  accountId = next;
}

export function loadSessionComposerDraft(
  key: string | null | undefined,
): SessionComposerDraft {
  if (!key) return { text: '', images: [] };
  const stored = drafts.get(scopedKey(key));
  return stored ? cloneDraft(stored) : { text: '', images: [] };
}

export function saveSessionComposerDraft(
  key: string | null | undefined,
  draft: SessionComposerDraft,
): boolean {
  if (!key) return false;
  const scoped = scopedKey(key);
  if (!draft.text.trim() && draft.images.length === 0) {
    drafts.delete(scoped);
    return true;
  }
  drafts.set(scoped, cloneDraft(draft));
  return true;
}

export function clearSessionComposerDraft(key: string | null | undefined): boolean {
  if (!key) return false;
  drafts.delete(scopedKey(key));
  return true;
}

export function resetSessionComposerDraftsForTests(): void {
  drafts.clear();
  accountId = null;
}
