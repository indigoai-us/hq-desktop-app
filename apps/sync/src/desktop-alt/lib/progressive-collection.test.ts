import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_PROJECT_LIMIT,
  PROJECT_RENDER_BATCH,
  progressiveWindow,
} from './progressive-collection';

describe('progressive project rendering', () => {
  const projects = Array.from({ length: 61 }, (_, index) => `project-${index + 1}`);

  it('caps the overview at a small ranked preview with an honest remainder', () => {
    const window = progressiveWindow(projects, OVERVIEW_PROJECT_LIMIT, OVERVIEW_PROJECT_LIMIT);
    expect(OVERVIEW_PROJECT_LIMIT).toBe(3);
    expect(window.items).toEqual(projects.slice(0, 3));
    expect(window.remaining).toBe(58);
    expect(window.nextCount).toBe(6);
  });

  it('renders full Projects in bounded batches without losing data', () => {
    const first = progressiveWindow(projects, PROJECT_RENDER_BATCH, PROJECT_RENDER_BATCH);
    expect(first.items).toHaveLength(24);
    expect(first.remaining).toBe(37);
    expect(first.nextCount).toBe(48);

    const second = progressiveWindow(projects, first.nextCount, PROJECT_RENDER_BATCH);
    expect(second.items).toHaveLength(48);
    expect(second.remaining).toBe(13);
    expect(second.nextCount).toBe(61);

    const final = progressiveWindow(projects, second.nextCount, PROJECT_RENDER_BATCH);
    expect(final.items).toEqual(projects);
    expect(final.remaining).toBe(0);
    expect(final.nextCount).toBe(61);
  });

  it('clamps invalid counts and never mutates the source collection', () => {
    const source = Object.freeze(['a', 'b', 'c']);
    expect(progressiveWindow(source, Number.NaN, 0)).toEqual({
      items: [],
      remaining: 3,
      nextCount: 1,
    });
    expect(source).toEqual(['a', 'b', 'c']);
  });
});
