import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_STAGES,
  BLOCKING_STAGES,
  partitionStages,
  STAGE_ORDER,
} from './onboarding-setup';

describe('partitionStages (US-004 blocking install phase)', () => {
  it('splits a full run into the blocking phase and the background phase', () => {
    expect(partitionStages('content')).toEqual({
      blocking: ['content', 'git-init', 'personalize'],
      background: ['deps', 'initial-sync', 'indexing'],
    });
  });

  it('keeps tool installs, the first sync and indexing out of the blocking phase', () => {
    const { blocking } = partitionStages('content');
    expect(blocking).not.toContain('deps');
    expect(blocking).not.toContain('initial-sync');
    expect(blocking).not.toContain('indexing');
  });

  it('skips stages before a resumed start stage', () => {
    expect(partitionStages('git-init')).toEqual({
      blocking: ['git-init', 'personalize'],
      background: ['indexing'],
    });
  });

  it('resuming at a background stage still runs the blocking stages not yet done', () => {
    expect(partitionStages('initial-sync')).toEqual({
      blocking: ['git-init', 'personalize'],
      background: ['initial-sync', 'indexing'],
    });
  });

  it('resuming at the last stage leaves an empty blocking phase', () => {
    expect(partitionStages('indexing')).toEqual({
      blocking: [],
      background: ['indexing'],
    });
  });

  it('covers every stage exactly once', () => {
    const all = [...BLOCKING_STAGES, ...BACKGROUND_STAGES];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...STAGE_ORDER].sort());
  });
});
