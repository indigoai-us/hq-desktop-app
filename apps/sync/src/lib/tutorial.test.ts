import { describe, expect, it } from 'vitest';

import { TUTORIAL_FIRST_LESSON_URL, tutorialUrl } from './tutorial';

describe('desktop tutorial handoff', () => {
  it('opens the canonical first lesson with source attribution', () => {
    expect(tutorialUrl('hq_desktop_tray')).toBe(
      `${TUTORIAL_FIRST_LESSON_URL}?source=hq_desktop_tray`,
    );
  });
});
