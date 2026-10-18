/**
 * Sample earned badges for the design harness. Production reads them from
 * hq-pro (badge-loader.svelte.ts); the harness installs this source first, so
 * every person and bot gets a stable, plausible set and the profile panes can
 * be judged with real art. Same name, same badges, every reload.
 */
import { BADGE_BY_ID, earnedTier, type BadgeProgress, type BadgeProgressSource, type BadgeSource, type EarnedBadge } from '@hq/ui';

const PEOPLE: EarnedBadge[] = [
  { id: 'founding', earnedAt: '2026-03-02' },
  { id: 'founder', earnedAt: '2026-03-04' },
  { id: 'bughunter', tier: 2, earnedAt: '2026-09-28' },
  { id: 'liftoff', tier: 1, earnedAt: '2026-10-06' },
  { id: 'poweruser', tier: 3, earnedAt: '2026-09-14' },
  { id: 'connector', tier: 1, earnedAt: '2026-08-21' },
  { id: 'teambuilder', tier: 2, earnedAt: '2026-07-30' },
  { id: 'regular', tier: 3, earnedAt: '2026-09-02' },
  { id: 'sharer', tier: 1, earnedAt: '2026-10-01' },
];

const BOTS: EarnedBadge[] = [
  { id: 'liftoff', tier: 2, earnedAt: '2026-10-05' },
  { id: 'poweruser', tier: 3, earnedAt: '2026-09-30' },
  { id: 'closer', tier: 2, earnedAt: '2026-10-03' },
  { id: 'shipit', tier: 1, earnedAt: '2026-09-22' },
];

/**
 * The honors badges (OG, Captain, Patient Zero, Core Builder, Ecom Rat) go
 * to named people, not to a random mix: here, Corey Epstein has the first
 * four and Spencer has Ecom Rat, so the Legendary tier and Core Builder's
 * fourth level can be seen in the harness.
 */
const HONORS: Readonly<Record<string, EarnedBadge[]>> = {
  'corey epstein': [
    { id: 'og', tier: 'L', earnedAt: '2026-10-11' },
    { id: 'captain', tier: 'L', earnedAt: '2026-10-11' },
    { id: 'patientzero', tier: 'L', earnedAt: '2026-10-11' },
    { id: 'corebuilder', tier: 'L', earnedAt: '2026-10-11' },
  ],
  spencer: [{ id: 'ecomrat', tier: 'L', earnedAt: '2026-10-16' }],
};

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A badge's level as a number: Bronze 1 to Gold 3, Legendary 4 (Founding Member and Founder are Gold). */
export function badgeLevel(b: EarnedBadge): number {
  if (b.id === 'founding' || b.id === 'founder') return 3;
  return b.tier === 'L' ? 4 : (b.tier ?? 1);
}

/**
 * Each person's highest level, so the avatar tier marks show every tier in
 * the harness: the regular cast is pinned, anyone else gets one by name.
 * 0 is no badges at all.
 */
const TOP_LEVEL: Readonly<Record<string, number>> = {
  'ada lovelace': 3,
  'corey epstein': 3,
  'maya chen': 2,
  'jacob moore': 1,
  'stefan johnson': 0,
  'grace hopper': 3,
  'katherine johnson': 2,
  'priya natarajan': 1,
  'leo park': 3,
};

export const sampleBadges: BadgeSource = ({ kind, name }) => {
  const key = name.trim().toLowerCase();
  const h = hash(key);
  if (kind === 'bot') return BOTS.slice(0, 2 + (h % 3));
  const top = TOP_LEVEL[key] ?? h % 4;
  const allowed = PEOPLE.filter((b) => badgeLevel(b) <= top);
  if (!allowed.length) return [];
  // Always the badge at their top level, then a mix of the rest by name.
  const lead = allowed.find((b) => badgeLevel(b) === top) ?? allowed[0]!;
  const rest = allowed.filter((b) => b !== lead && ((h >> PEOPLE.indexOf(b)) & 1) === 1);
  return [...(HONORS[key] ?? []), lead, ...rest];
};

/**
 * Sample progress toward the badges someone has not earned yet, for the
 * Badges page. Targets are each badge's first level in the catalog.
 */
const PROGRESS: BadgeProgress[] = [
  { id: 'liftoff', current: 0, target: 5, unit: 'deploys' },
  { id: 'poweruser', current: 64, target: 100, unit: 'runs' },
  { id: 'toolbox', current: 3, target: 5, unit: 'skills' },
  { id: 'maker', current: 2, target: 5, unit: 'skills' },
  { id: 'teambuilder', current: 1, target: 3, unit: 'invites' },
  { id: 'fleet', current: 0, target: 1, unit: 'agents' },
  { id: 'connector', current: 0, target: 3, unit: 'apps' },
  { id: 'sharer', current: 0, target: 1, unit: 'files' },
  { id: 'shipit', current: 0, target: 1, unit: 'projects' },
  { id: 'closer', current: 7, target: 10, unit: 'stories' },
  { id: 'onfire', current: 4, target: 7, unit: 'days' },
  { id: 'bughunter', current: 1, target: 3, unit: 'reports' },
  { id: 'corebuilder', current: 0, target: 1, unit: 'PRs' },
];

export const sampleProgress: BadgeProgressSource = () => PROGRESS;

/**
 * `?view=shell&earn=<badge>[:<tier>]` raises the "You earned" notice a few
 * seconds after the shell loads, to demo the card reveal (Gold carries
 * "Reveal card"). Several are comma separated, e.g.
 * `earn=founding,poweruser:3,liftoff:1`, and raise one notice for all of
 * them ("You earned 3 badges", "Reveal cards"). Harness only: no production code
 * path raises this notice.
 *
 * Tiers follow production's rules (`earnedTier`, as the loader reads
 * hq-pro): a single-level badge shows at its own tier whatever is asked
 * (`founding:L` is Gold), and a tier the badge can't be earned at drops it,
 * as the loader drops such a row (`closer:L`). Unknown badges are dropped
 * too (owner review 2026-10-12).
 */
export function earnedFromUrl(search: string): EarnedBadge[] {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get('earn');
  if (!raw) return [];
  const today = new Date().toISOString().slice(0, 10);
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const [id, tier] = part.split(':');
      const def = BADGE_BY_ID[id];
      if (!def) return [];
      const asked = tier === 'L' ? 'L' : tier === '1' || tier === '2' || tier === '3' ? (Number(tier) as 1 | 2 | 3) : undefined;
      // No tier, or one that isn't a tier at all: the badge's own display tier.
      if (!asked) return [{ id, earnedAt: today }];
      const t = earnedTier(def, asked);
      return t === null ? [] : [{ id, tier: t, earnedAt: today }];
    });
}
