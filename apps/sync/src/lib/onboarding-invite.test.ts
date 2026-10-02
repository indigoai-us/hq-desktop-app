import { describe, expect, it } from 'vitest';
import {
  classifyInviteError,
  hqProErrorCode,
  HqProRequestError,
  inviteErrorMessage,
  INVITE_ERROR_KINDS,
  isAlreadyExists,
  isInviteNotPending,
  normalizeHttpStatus,
  normalizeInviteErrorKind,
} from './onboarding-invite';

describe('onboarding invite errors', () => {
  it('reads a safe code label from an error body and ignores anything else', () => {
    expect(hqProErrorCode('{"error":"x","code":"MEMBERSHIP_ALREADY_EXISTS"}')).toBe(
      'MEMBERSHIP_ALREADY_EXISTS',
    );
    expect(hqProErrorCode('{"code":"person@example.com has spaces"}')).toBeNull();
    expect(hqProErrorCode('not json')).toBeNull();
    expect(hqProErrorCode(undefined)).toBeNull();
  });

  it('recognises the 409 already-exists answer and the resend 404', () => {
    expect(isAlreadyExists(new HqProRequestError(409, 'MEMBERSHIP_ALREADY_EXISTS'))).toBe(true);
    expect(isAlreadyExists(new HqProRequestError(409, null))).toBe(true);
    expect(isAlreadyExists(new HqProRequestError(409, 'SOMETHING_ELSE'))).toBe(false);
    expect(isAlreadyExists(new HqProRequestError(400, 'MEMBERSHIP_ALREADY_EXISTS'))).toBe(false);
    expect(isAlreadyExists(new Error('409'))).toBe(false);
    expect(isInviteNotPending(new HqProRequestError(404, 'INVITE_NOT_PENDING'))).toBe(true);
    expect(isInviteNotPending(new HqProRequestError(404, null))).toBe(false);
  });

  it.each([
    [402, null, 'plan_limit'],
    [400, null, 'invalid_email'],
    [403, 'FORBIDDEN', 'forbidden'],
    [429, null, 'rate_limited'],
    [503, null, 'server_error'],
    [404, 'INVITE_NOT_PENDING', 'already_member'],
    [409, 'MEMBERSHIP_ALREADY_EXISTS', 'already_member'],
    [418, null, 'request_failed'],
  ] as const)('classifies HTTP %i (%s) as %s and keeps the status', (status, code, kind) => {
    expect(classifyInviteError(new HqProRequestError(status, code))).toEqual({
      kind,
      httpStatus: status,
    });
  });

  it('classifies transport failures without a status', () => {
    expect(classifyInviteError('Network error: error sending request')).toEqual({ kind: 'network' });
    expect(classifyInviteError(new Error('hq-pro returned an invalid JSON body'))).toEqual({
      kind: 'request_failed',
    });
  });

  it('has a specific message for every kind', () => {
    const messages = INVITE_ERROR_KINDS.map(inviteErrorMessage);
    expect(new Set(messages).size).toBe(INVITE_ERROR_KINDS.length);
    expect(inviteErrorMessage('plan_limit')).toMatch(/plan/i);
    expect(inviteErrorMessage('network')).toMatch(/connection/i);
  });

  it('normalizes telemetry values to closed sets', () => {
    expect(normalizeInviteErrorKind('plan_limit')).toBe('plan_limit');
    expect(normalizeInviteErrorKind('/Users/alice')).toBe('request_failed');
    expect(normalizeHttpStatus(409)).toBe(409);
    expect(normalizeHttpStatus(99)).toBeUndefined();
    expect(normalizeHttpStatus(600)).toBeUndefined();
    expect(normalizeHttpStatus('409')).toBeUndefined();
    expect(normalizeHttpStatus(409.5)).toBeUndefined();
  });
});
