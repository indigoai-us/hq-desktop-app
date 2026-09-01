import { describe, expect, it } from 'vitest';
import { DEFAULT_SKELETON_DELAY_MS, loadPhase, type LoadPhase } from './load-state';

const PHASES: LoadPhase[] = ['loading', 'error', 'empty', 'ready'];

describe('loadPhase', () => {
  it('returns ready whenever count > 0, even while a refresh is in flight', () => {
    expect(loadPhase({ loading: true, error: '', count: 1 })).toBe('ready');
    expect(loadPhase({ loading: false, error: '', count: 4 })).toBe('ready');
  });

  it('returns ready when data is present during a background error', () => {
    expect(
      loadPhase({
        loading: false,
        error: 'Could not load agency teams.',
        count: 3,
      }),
    ).toBe('ready');
  });

  it('returns ready when data is present while loading and a background error is set', () => {
    expect(loadPhase({ loading: true, error: 'fail', count: 2 })).toBe('ready');
  });

  it('returns loading when there is no data and loading is true', () => {
    expect(loadPhase({ loading: true, error: '', count: 0 })).toBe('loading');
  });

  it('prefers loading over error when there is no data yet', () => {
    expect(loadPhase({ loading: true, error: 'fail', count: 0 })).toBe('loading');
  });

  it('returns error when there is no data, loading is done, and error is set', () => {
    expect(loadPhase({ loading: false, error: 'fail', count: 0 })).toBe('error');
  });

  it('returns empty when there is no data, no error, and not loading', () => {
    expect(loadPhase({ loading: false, error: '', count: 0 })).toBe('empty');
  });

  it('treats a zero count as not-ready even if error is an empty string', () => {
    expect(loadPhase({ loading: false, error: '', count: 0 })).not.toBe('ready');
    expect(loadPhase({ loading: false, error: '', count: 0 })).toBe('empty');
  });

  it('covers every LoadPhase branch', () => {
    const seen = new Set<LoadPhase>([
      loadPhase({ loading: true, error: '', count: 0 }),
      loadPhase({ loading: false, error: 'fail', count: 0 }),
      loadPhase({ loading: false, error: '', count: 0 }),
      loadPhase({ loading: false, error: 'fail', count: 1 }),
    ]);
    expect([...seen].sort()).toEqual([...PHASES].sort());
  });
});

describe('DEFAULT_SKELETON_DELAY_MS', () => {
  it('is 150ms so fast loads do not flash a skeleton', () => {
    expect(DEFAULT_SKELETON_DELAY_MS).toBe(150);
  });
});
