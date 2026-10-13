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
    expect(earnedFromUrl('?view=shell&earn=founding,poweruser:3, liftoff:1,corebuilder:L')).toEqual([
      { id: 'founding', earnedAt: today },
      { id: 'poweruser', tier: 3, earnedAt: today },
      { id: 'liftoff', tier: 1, earnedAt: today },
      { id: 'corebuilder', tier: 'L', earnedAt: today },
    ]);
    expect(earnedFromUrl('?view=shell')).toEqual([]);
    expect(earnedFromUrl('earn=sharer:9')).toEqual([{ id: 'sharer', earnedAt: today }]);
  });

  // Owner review 2026-10-12: the harness used to show a Legendary toast and
  // card for any badge (`founding:L`, `closer:L`) that production never would.
  // It now follows the loader's rules for hq-pro's badges.
  it('only raises tiers a badge can be earned at, as production does', () => {
    const today = new Date().toISOString().slice(0, 10);
    // A three-level badge has no Legendary: dropped, as the loader drops the row.
    expect(earnedFromUrl('?earn=closer:L')).toEqual([]);
    expect(earnedFromUrl('?earn=liftoff:L,closer:2')).toEqual([{ id: 'closer', tier: 2, earnedAt: today }]);
    // A single-level badge shows at its own tier whatever is asked.
    expect(earnedFromUrl('?earn=founding:L,founder:1,og:2')).toEqual([
      { id: 'founding', tier: 3, earnedAt: today },
      { id: 'founder', tier: 3, earnedAt: today },
      { id: 'og', tier: 'L', earnedAt: today },
    ]);
    // Badges the catalog doesn't know are dropped, as the loader drops them.
    expect(earnedFromUrl('?earn=nope:1,shipit:1')).toEqual([{ id: 'shipit', tier: 1, earnedAt: today }]);
  });

  it('raises the notice from the harness entry only', () => {
    const main = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../dev-harness/main.ts'), 'utf8');
    expect(main).toContain('earnedFromUrl(window.location.search)');
    // Several badges at once raise one notice, as after a stretch away.
    expect(main).toContain('announceBadgesEarned(earned)');
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
// Corey Epstein holds the honors badges (2026-10-11), so his top is Legendary.
describe('sample badges span the tiers', () => {
  it('gives the regular cast a top badge at each level, and someone none', () => {
    // 4 Legendary, 3 Gold, 2 Silver, 1 Bronze, 0 none.
    const top = (name: string) => Math.max(0, ...sampleBadges({ kind: 'person', name }).map(badgeLevel));
    expect(top('Ada Lovelace')).toBe(3);
    expect(top('Corey Epstein')).toBe(4);
    expect(top('Maya Chen')).toBe(2);
    expect(top('Jacob Moore')).toBe(1);
    expect(top('Stefan Johnson')).toBe(0);
  });

  it('gives only Corey Epstein the honors badges, with Core Builder at Legendary', () => {
    const ids = (name: string) => sampleBadges({ kind: 'person', name }).map((b) => b.id);
    expect(sampleBadges({ kind: 'person', name: 'Corey Epstein' })).toEqual(
      expect.arrayContaining([
        { id: 'og', tier: 'L', earnedAt: '2026-10-11' },
        { id: 'captain', tier: 'L', earnedAt: '2026-10-11' },
        { id: 'patientzero', tier: 'L', earnedAt: '2026-10-11' },
        { id: 'corebuilder', tier: 'L', earnedAt: '2026-10-11' },
      ]),
    );
    for (const name of ['Ada Lovelace', 'Maya Chen', 'Jacob Moore']) {
      expect(ids(name)).not.toEqual(expect.arrayContaining(['og']));
    }
  });
});
