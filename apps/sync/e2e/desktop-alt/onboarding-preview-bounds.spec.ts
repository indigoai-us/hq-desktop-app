import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import { WIZARD_STEPS } from '../../src/lib/onboarding-wizard';

/**
 * The browser preview harness accepts `?step=N` to open a wizard panel
 * directly. It used to clamp N to a hand-written `3`, a ceiling that predated
 * every step added after Consent — so `?step=4` upward silently fell back to
 * Welcome. That included the Ready screen (5) and the harness's own default
 * entry point, which meant the launch buttons could not be previewed at all
 * and a reviewer checking them saw the sign-in panel instead.
 *
 * Anchored to WIZARD_STEPS so adding a step cannot re-open the gap.
 */
describe('onboarding preview bounds', () => {
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const previewConfig = readRepoFile('vite.preview.config.ts');

  it('bounds ?step by the wizard step list, not a literal', () => {
    expect(harness).toContain('WIZARD_STEPS[WIZARD_STEPS.length - 1].index');
    expect(harness).toContain('requestedOnboardingStep <= LAST_ONBOARDING_STEP');
    expect(harness).not.toContain('requestedOnboardingStep <= 3');
  });

  it('keeps the harness default entry point inside those bounds', () => {
    const match = previewConfig.match(/step=(\d+)/);
    expect(match).not.toBeNull();

    const defaultStep = Number(match?.[1]);
    const lastStep = WIZARD_STEPS[WIZARD_STEPS.length - 1].index;

    expect(defaultStep).toBeGreaterThanOrEqual(0);
    expect(defaultStep).toBeLessThanOrEqual(lastStep);
  });

  it('can address the Ready screen, where the launch buttons live', () => {
    const ready = WIZARD_STEPS.find((step) => step.id === 'ready');
    expect(ready).toBeDefined();
    expect(ready!.index).toBeLessThanOrEqual(
      WIZARD_STEPS[WIZARD_STEPS.length - 1].index,
    );
  });
});
