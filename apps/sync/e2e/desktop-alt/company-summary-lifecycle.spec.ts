import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Regression — pausing and resuming sync for the company already on screen
 * must cross from the cleared/disabled state back to a live summary.
 *
 * The hook deliberately ignores same-slug effect reruns because the desktop
 * shell frequently replaces a company object with an equivalent one. The
 * enabled transition is the one exception: after sync is turned back on for
 * that same slug, it must force one load instead of taking the identity-churn
 * early return.
 */
describe('company summary lifecycle', () => {
  const summary = readRepoFile('src/desktop-alt/lib/company-summary.svelte.ts');

  it('force-loads once when the current slug transitions from disabled to enabled', () => {
    expect(summary).toContain('let wasEnabled = true');
    expect(summary).toContain('const reenabled = enabled && !wasEnabled');
    expect(summary).toContain('wasEnabled = enabled');
    expect(summary).toContain('if (slug === activeSlug && !reenabled)');
    expect(summary).toContain('companyStore.loadSummary(slug, reenabled)');

    const transition = summary.indexOf('const reenabled = enabled && !wasEnabled');
    const sameSlugGuard = summary.indexOf('if (slug === activeSlug && !reenabled)');
    const load = summary.indexOf('companyStore.loadSummary(slug, reenabled)');
    expect(transition).toBeGreaterThan(-1);
    expect(transition).toBeLessThan(sameSlugGuard);
    expect(sameSlugGuard).toBeLessThan(load);
  });

  it('retains the monotonic request guard used to survive same-slug identity churn', () => {
    expect(summary).toContain('const myRequest = ++requestId');
    expect(summary).toContain('if (myRequest === requestId)');
    expect(summary).not.toContain('let cancelled = false');
    expect(summary).not.toContain('cancelled = true');
  });
});
