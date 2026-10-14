import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { badgeLevel, earnedFromUrl, sampleBadges, sampleProgress } from '../../dev-harness/badge-fixtures';

// Badge cards, step 3 (owner decision 2026-10-08): the design harness demos
// the "You earned" notice and the card reveal with ?earn=<badge>[:<tier>].
// The harness is never reachable from production (harness-boundary.test.ts).
describe('badge harness switches', () => {
  it('reads ?earn= as earned badges, with an optional tier', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(earnedFromUrl('?view=shell&earn=founding,poweruser:3, liftoff:1,closer:L')).toEqual([
      { id: 'founding', earnedAt: today },
      { id: 'poweruser', tier: 3, earnedAt: today },
      { id: 'liftoff', tier: 1, earnedAt: today },
      { id: 'closer', tier: 'L', earnedAt: today },
    ]);
    expect(earnedFromUrl('?view=shell')).toEqual([]);
    expect(earnedFromUrl('earn=sharer:9')).toEqual([{ id: 'sharer', earnedAt: today }]);
  });

  it('raises the notice from the harness entry only', () => {
    const main = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../dev-harness/main.ts'), 'utf8');
    expect(main).toContain('earnedFromUrl(window.location.search)');
    expect(main).toContain('announceBadgeEarned(badge)');
  });

  it('gives sample progress toward first levels for the Badges page', () => {
    const progress = sampleProgress({ kind: 'person', name: 'Ada Lovelace' });
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) {
      expect(p.target).toBeGreaterThan(0);
      expect(p.current).toBeLessThanOrEqual(p.target);
      expect(p.unit).toMatch(/s$/);
    }
  });
});

// Avatar tier marks (owner review 2026-10-09): the harness cast spans every
// tier. Founding Member is a plain Gold badge (adopted criteria 2026-10-10).
describe('sample badges span the tiers', () => {
  it('gives the regular cast a top badge at each level, and someone none', () => {
    // 3 Gold, 2 Silver, 1 Bronze, 0 none.
    const top = (name: string) => Math.max(0, ...sampleBadges({ kind: 'person', name }).map(badgeLevel));
    expect(top('Ada Lovelace')).toBe(3);
    expect(top('Corey Epstein')).toBe(3);
    expect(top('Maya Chen')).toBe(2);
    expect(top('Jacob Moore')).toBe(1);
    expect(top('Stefan Johnson')).toBe(0);
  });
});
