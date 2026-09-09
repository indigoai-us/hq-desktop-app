import { describe, expect, it } from 'vitest';
import {
  createSetupRunId,
  ERROR_CATEGORIES,
  FAILED_DEPENDENCIES,
  normalizeErrorCategory,
  normalizeFailedDependency,
  normalizeFailedStageIds,
  setupFailureTelemetryDetails,
  STAGE_ORDER,
} from './onboarding-setup';

describe('setup failure telemetry details', () => {
  it('keeps both closed vocabularies and normalizes unknown values', () => {
    for (const dependency of FAILED_DEPENDENCIES) {
      expect(normalizeFailedDependency(dependency)).toBe(dependency);
    }
    expect(normalizeFailedDependency('npm-private-package')).toBe('unknown');

    for (const category of ERROR_CATEGORIES) {
      expect(normalizeErrorCategory(category)).toBe(category);
    }
    expect(normalizeErrorCategory('/Users/example/HQ/secret-error')).toBe('unknown');
  });

  it('uses a typed category for each representative stage failure', () => {
    expect(
      setupFailureTelemetryDetails({
        stageId: 'deps',
        failedDependency: 'node',
        errorCategory: 'network',
      }),
    ).toEqual({ failedDependency: 'node', errorCategory: 'network' });
    expect(
      setupFailureTelemetryDetails({ stageId: 'content', errorCategory: 'timeout' }),
    ).toEqual({ errorCategory: 'timeout' });
    expect(
      setupFailureTelemetryDetails({ stageId: 'git-init', errorCategory: 'exit-nonzero' }),
    ).toEqual({ errorCategory: 'exit-nonzero' });
    expect(
      setupFailureTelemetryDetails({ stageId: 'indexing', errorCategory: 'spawn-failed' }),
    ).toEqual({ errorCategory: 'spawn-failed' });
  });

  it('names a dependency only for deps failures', () => {
    expect(
      setupFailureTelemetryDetails({
        stageId: 'deps',
        failedDependency: 'qmd',
        errorCategory: 'checksum',
      }),
    ).toEqual({ failedDependency: 'qmd', errorCategory: 'checksum' });
    expect(
      setupFailureTelemetryDetails({
        stageId: 'git-init',
        failedDependency: 'git',
        errorCategory: 'permission',
      }),
    ).toEqual({ errorCategory: 'permission' });
  });

  it('keeps only known failed stages in a bounded completion list', () => {
    const failedStages = normalizeFailedStageIds([
      ...STAGE_ORDER,
      'not-a-stage',
      'deps',
      '/Users/example/HQ',
    ]);

    expect(failedStages).toEqual(STAGE_ORDER);
    expect(failedStages).toHaveLength(STAGE_ORDER.length);
  });

  it('creates a distinct opaque identifier for each setup run', () => {
    const first = createSetupRunId(() => '11111111-1111-4111-8111-111111111111');
    const second = createSetupRunId(() => '22222222-2222-4222-8222-222222222222');

    expect(first).toBe('11111111-1111-4111-8111-111111111111');
    expect(second).toBe('22222222-2222-4222-8222-222222222222');
    expect(first).not.toBe(second);
  });
});
