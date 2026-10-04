import { describe, expect, it } from 'vitest';
import { liveProgressCaption } from './live-progress-caption';

describe('live progress caption after a fully in-sync personal walk', () => {
  // A walk of thousands of unchanged files must read as up to date, not as
  // thousands of files transferred.
  it('does not read a tree walk as transferred', () => {
    const caption = liveProgressCaption({
      syncFilesProgressed: 0,
      syncPlanTotalFiles: 0,
      syncTotalFiles: 0,
      fanoutTotal: 4,
      fanoutDoneCount: 4,
      personalFilesDone: 2_503,
      personalFilesTotal: 2_503,
    });
    expect(caption.kind).toBe('up-to-date');
  });
});
