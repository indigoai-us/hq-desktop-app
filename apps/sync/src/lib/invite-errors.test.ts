import { describe, it, expect } from 'vitest';
import {
  isAlreadyScheduledError,
  isPlanRequiredError,
  planRequiredUpgradeUrl,
} from './invite-errors';

describe('isAlreadyScheduledError', () => {
  it('matches the atomic dedup-lock 409 (bot-already-scheduling)', () => {
    expect(
      isAlreadyScheduledError(
        'bot/invite HTTP 409: {"error":"A bot is already being scheduled for this meeting","code":"bot-already-scheduling"}',
      ),
    ).toBe(true);
  });

  it('matches the sibling / Recall dedup 409 (bot-already-scheduled)', () => {
    expect(
      isAlreadyScheduledError(
        'bot/invite HTTP 409: {"error":"A bot is already scheduled","code":"bot-already-scheduled"}',
      ),
    ).toBe(true);
  });

  it('matches a bare 409 with no structured code', () => {
    expect(isAlreadyScheduledError('bot/invite HTTP 409: upstream conflict')).toBe(true);
  });

  it('matches an Error instance, not just a string', () => {
    expect(isAlreadyScheduledError(new Error('HTTP 409 bot-already-scheduling'))).toBe(true);
  });

  it('does NOT match unrelated failures', () => {
    expect(isAlreadyScheduledError('bot/invite HTTP 500: server error')).toBe(false);
    expect(isAlreadyScheduledError('bot/invite parse: missing field `autoScheduled`')).toBe(false);
    expect(isAlreadyScheduledError('bot/invite fetch: connection reset')).toBe(false);
    expect(isAlreadyScheduledError(null)).toBe(false);
    expect(isAlreadyScheduledError(undefined)).toBe(false);
  });
});

describe('isPlanRequiredError', () => {
  it('matches the flattened 402 response with the required Team plan', () => {
    expect(
      isPlanRequiredError(
        'bot/invite HTTP 402: {"requiredPlan":"agents-500","code":"MEETING_PLAN_REQUIRED"}',
      ),
    ).toBe(true);
  });

  it('matches each backend plan-required sentinel without a status', () => {
    expect(isPlanRequiredError('requiredPlan agents-500')).toBe(true);
    expect(isPlanRequiredError('MEETING_PLAN_REQUIRED')).toBe(true);
  });

  it('does NOT match already-scheduled or unrelated errors', () => {
    expect(
      isPlanRequiredError(
        'bot/invite HTTP 409: {"code":"bot-already-scheduled"}',
      ),
    ).toBe(false);
    expect(isPlanRequiredError('bot/invite HTTP 500: server error')).toBe(false);
    expect(isPlanRequiredError(null)).toBe(false);
  });
});

describe('planRequiredUpgradeUrl', () => {
  it('preserves the server-selected upgrade URL from a flattened Tauri error', () => {
    const upgradeUrl = 'https://hq.computer/companies/acme/billing?upgrade=team';
    expect(
      planRequiredUpgradeUrl(
        new Error(
          `bot/invite HTTP 402: ${JSON.stringify({
            code: 'MEETING_PLAN_REQUIRED',
            requiredPlan: 'agents-500',
            upgradeUrl,
          })}`,
        ),
      ),
    ).toEqual({ kind: 'available', url: upgradeUrl });
  });

  it('returns no URL for unrelated failures or an invalid server URL', () => {
    expect(planRequiredUpgradeUrl('bot/invite HTTP 500: server error')).toEqual({
      kind: 'not-plan-error',
    });
    expect(
      planRequiredUpgradeUrl(
        'bot/invite HTTP 402: {"code":"MEETING_PLAN_REQUIRED","upgradeUrl":"file:///etc/passwd"}',
      ),
    ).toEqual({ kind: 'invalid' });
  });

  it('distinguishes a missing upgrade URL from a malformed one', () => {
    expect(planRequiredUpgradeUrl('bot/invite HTTP 402: {"code":"MEETING_PLAN_REQUIRED"}')).toEqual({
      kind: 'missing',
    });
    expect(
      planRequiredUpgradeUrl('bot/invite HTTP 402: {"code":"MEETING_PLAN_REQUIRED","upgradeUrl":" https://hq.computer/upgrade"}'),
    ).toEqual({ kind: 'invalid' });
  });
});
