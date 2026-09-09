import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSessionComposerDraft,
  loadSessionComposerDraft,
  resetSessionComposerDraftsForTests,
  saveSessionComposerDraft,
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
});
