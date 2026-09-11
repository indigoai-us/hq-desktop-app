import { describe, expect, it } from 'vitest';
import { checkResult, createRun } from './onboarding-qa';

describe('repeatable onboarding QA report', () => {
  it('keeps native acceptance pending even after a green simulator run', () => {
    const run = createRun('2026-09-06T00:00:00.000Z');
    expect(run.nativeChecks.length).toBeGreaterThanOrEqual(8);
    expect(run.nativeChecks.every(check => check.status === 'pending')).toBe(true);
    expect(run.resources).toEqual([]);
    expect(run.cleanupBudgetMs).toBe(120000);
    expect(run.mode).toBe('local-regression-not-live-e2e');
  });
  it('never treats failed, timed-out, or interrupted commands as passes', () => {
    expect(checkResult(0)).toBe('passed');
    expect(checkResult(1)).toBe('failed');
    expect(checkResult(null)).toBe('failed');
    expect(checkResult(0, 'timeout')).toBe('failed');
  });
});
