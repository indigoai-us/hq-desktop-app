import { describe, expect, it } from 'vitest';
import { checksPassing, conflictsNeedsYouCard } from './overview-model';
import type { Project } from './projects-model';

function project(partial: Partial<Project>): Project {
  return {
    id: 'p',
    name: 'p',
    title: 'P',
    company: 'acme',
    prdPath: '/hq/companies/acme/projects/p/prd.json',
    status: 'in-progress',
    storiesTotal: 0,
    storiesComplete: 0,
    ...partial,
  } as Project;
}

describe('checksPassing (US-004 / references.md formula)', () => {
  it('computes passed/total across all company projects', () => {
    const result = checksPassing([
      project({ storiesTotal: 4, storiesComplete: 2 }),
      project({ storiesTotal: 6, storiesComplete: 3 }),
    ]);
    expect(result).toEqual({ passed: 5, total: 10, percent: 50 });
  });

  it('hides the stat (null) when the denominator is 0 — never renders 0%', () => {
    expect(checksPassing([])).toBeNull();
    expect(checksPassing([project({ storiesTotal: 0, storiesComplete: 0 })])).toBeNull();
  });

  it('clamps malformed counts so passes can never exceed totals', () => {
    const result = checksPassing([project({ storiesTotal: 3, storiesComplete: 9 })]);
    expect(result).toEqual({ passed: 3, total: 3, percent: 100 });
  });
});

describe('conflictsNeedsYouCard', () => {
  it('returns null when nothing is pending', () => {
    expect(conflictsNeedsYouCard(0)).toBeNull();
    expect(conflictsNeedsYouCard(-1)).toBeNull();
  });

  it('offers keep-local / keep-cloud rescue actions with honest counts', () => {
    const one = conflictsNeedsYouCard(1);
    expect(one?.title).toBe('1 sync conflict needs a decision');
    const many = conflictsNeedsYouCard(3);
    expect(many?.title).toBe('3 sync conflicts need a decision');
    expect(many?.actions.map((a) => a.id)).toEqual(['keep-local', 'keep-cloud']);
    expect(many?.tone).toBe('warn');
  });

  it('disables actions while resolving', () => {
    const card = conflictsNeedsYouCard(2, true);
    expect(card?.actions.every((a) => a.disabled)).toBe(true);
    expect(card?.actions[0]?.label).toBe('Resolving…');
  });
});
