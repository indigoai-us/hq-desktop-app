import { describe, expect, it, vi } from 'vitest';
import {
  approveNextPhase,
  formatBytes,
  normalizePersonalRootView,
  personalRootAllowsSetup,
  personalRootCanRetry,
  personalRootOffersAdoption,
  personalRootReasonText,
  preparePersonalRoot,
  requestAdoptionPlan,
  type PersonalRootView,
} from './personal-root';

const base: PersonalRootView = {
  phase: 'adoption_review',
  rootPath: '/Users/test/hq',
  reason: null,
  retryable: false,
  nextPhase: null,
  plan: null,
};

const plan = {
  approvedPlanDigest: 'sha256:abc',
  fileCount: 3,
  byteCount: 30,
  uploadCount: 1,
  uploadBytes: 10,
  preservedOnly: [{ key: '.env', reason: 'secret' }],
  preservedOnlyTotal: 1,
  destinationUid: 'psn_1',
  destinationBucket: 'b',
  destinationRegion: 'us-east-1',
  destinationEndpoint: 'https://s3',
  historicalUids: [],
};

describe('personal root (H8, gated)', () => {
  it('lets setup continue only for legacy, new, or confirmed roots', () => {
    expect(personalRootAllowsSetup(null)).toBe(true);
    for (const phase of ['legacy', 'initialized', 'seeded', 'owner_observed', 'resume_authorized'] as const) {
      expect(personalRootAllowsSetup({ ...base, phase })).toBe(true);
    }
    for (const phase of ['adoption_review', 'preserved', 'adopted', 'baseline_ready', 'paused'] as const) {
      expect(personalRootAllowsSetup({ ...base, phase })).toBe(false);
    }
    // A typed pause shown over an otherwise ready phase still stops setup.
    expect(personalRootAllowsSetup({ ...base, phase: 'initialized', reason: 'busy' })).toBe(false);
  });

  it('never offers adoption for a folder owned by another account', () => {
    expect(personalRootOffersAdoption(base)).toBe(true);
    expect(personalRootOffersAdoption({ ...base, reason: 'owner_mismatch' })).toBe(false);
    expect(personalRootOffersAdoption({ ...base, phase: 'paused', reason: 'owner_mismatch' })).toBe(
      false,
    );
  });

  it('offers a retry only when the wrapper said the pause is retryable', () => {
    expect(personalRootCanRetry({ ...base, phase: 'paused', reason: 'busy', retryable: true })).toBe(
      true,
    );
    expect(personalRootCanRetry({ ...base, phase: 'paused', reason: 'state_changed' })).toBe(false);
  });

  it('explains every typed reason in plain words', () => {
    expect(personalRootReasonText('unsupported_cli')).toContain('Update HQ');
    expect(personalRootReasonText('owner_mismatch')).toContain('different HQ account');
    expect(personalRootReasonText('something_new')).toContain('Your files are untouched');
    expect(personalRootReasonText(null)).toBe('');
  });

  it('sends exactly the next phase and the digest on screen, once per click', async () => {
    const invoke = vi.fn().mockResolvedValue({ ...base, phase: 'preserved', nextPhase: 'adopt', plan });
    const next = await approveNextPhase(invoke, { ...base, nextPhase: 'preserve', plan });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('personal_root_approve_phase', {
      phase: 'preserve',
      planDigest: 'sha256:abc',
    });
    expect(next.phase).toBe('preserved');
    await expect(approveNextPhase(invoke, base)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('calls the prepare and plan commands with only the path', async () => {
    const invoke = vi.fn().mockResolvedValue({ phase: 'legacy' });
    expect((await preparePersonalRoot(invoke, '/Users/test/hq')).phase).toBe('legacy');
    expect(invoke).toHaveBeenCalledWith('prepare_personal_root', { path: '/Users/test/hq' });
    await requestAdoptionPlan(invoke);
    expect(invoke).toHaveBeenLastCalledWith('personal_root_plan_adoption');
  });

  it('normalizes a partial view to a stopped state', () => {
    expect(normalizePersonalRootView(undefined).phase).toBe('paused');
    expect(normalizePersonalRootView({ phase: 'legacy' }).retryable).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});
