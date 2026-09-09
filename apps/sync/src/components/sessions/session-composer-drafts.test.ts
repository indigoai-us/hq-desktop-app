import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionComposerDraft,
  loadSessionComposerDraft,
  resetSessionComposerDraftsForTests,
  saveSessionComposerDraft,
  setSessionComposerDraftAccount,
} from './session-composer-drafts';

afterEach(() => {
  resetSessionComposerDraftsForTests();
});

describe('session composer drafts', () => {
  it('keeps text and images by draft key without putting bytes in navigation history', () => {
    const key = 'sessions:new?draft=abc';
    expect(
      saveSessionComposerDraft(key, {
        text: 'keep this prompt',
        images: [{ mediaType: 'image/png', base64: 'QQ==', name: 'shot.png' }],
      }),
    ).toBe(true);
    expect(loadSessionComposerDraft(key)).toEqual({
      text: 'keep this prompt',
      images: [{ mediaType: 'image/png', base64: 'QQ==', name: 'shot.png' }],
    });
    clearSessionComposerDraft(key);
    expect(loadSessionComposerDraft(key)).toEqual({ text: '', images: [] });
  });

  it('namespaces drafts by account and clears them on sign-out or switch', () => {
    const key = 'sessions:new?draft=shared';
    setSessionComposerDraftAccount('acct_ada');
    expect(
      saveSessionComposerDraft(key, { text: 'ada secret', images: [] }),
    ).toBe(true);
    expect(loadSessionComposerDraft(key).text).toBe('ada secret');

    setSessionComposerDraftAccount('acct_bea');
    expect(loadSessionComposerDraft(key)).toEqual({ text: '', images: [] });
    expect(saveSessionComposerDraft(key, { text: 'bea draft', images: [] })).toBe(true);
    expect(loadSessionComposerDraft(key).text).toBe('bea draft');

    setSessionComposerDraftAccount('acct_ada');
    expect(loadSessionComposerDraft(key)).toEqual({ text: '', images: [] });

    setSessionComposerDraftAccount('acct_bea');
    expect(saveSessionComposerDraft(key, { text: 'bea again', images: [] })).toBe(true);
    setSessionComposerDraftAccount(null);
    expect(loadSessionComposerDraft(key)).toEqual({ text: '', images: [] });
  });
});
