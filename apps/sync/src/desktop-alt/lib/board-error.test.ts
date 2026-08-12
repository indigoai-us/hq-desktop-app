import { describe, expect, it } from 'vitest';
import { presentBoardError } from './board-error';

describe('presentBoardError', () => {
  it('maps AUTH_REQUIRED rejections to a sign-in message', () => {
    const presented = presentBoardError('AUTH_REQUIRED: board (HTTP 401 Unauthorized)');
    expect(presented.message).toBe('Session expired — sign in again');
    expect(presented.authRequired).toBe(true);
    expect(presented.detail).toBe('AUTH_REQUIRED: board (HTTP 401 Unauthorized)');
  });

  it('maps COMPANY_NOT_CONNECTED to a calm cloud message', () => {
    const presented = presentBoardError(
      "COMPANY_NOT_CONNECTED: company 'acme' is not connected to cloud",
    );
    expect(presented.message).toBe("This company isn't connected to cloud yet");
    expect(presented.authRequired).toBe(false);
  });

  it('maps COMPANY_NOT_SYNCED (memberships-miss variant) to a reconnect message, hiding the raw diagnostic', () => {
    const raw =
      "COMPANY_NOT_SYNCED: company 'acme' is not synced: manifest cloud_uid cmp_old not found in your cloud memberships";
    const presented = presentBoardError(raw);
    expect(presented.message).toBe(
      'This company needs to be reconnected — open the menubar and sync',
    );
    // The internal diagnostic must never surface as the primary line…
    expect(presented.message).not.toMatch(/cloud_uid|manifest/);
    // …but stays available for logs.
    expect(presented.detail).toBe(raw);
  });

  it('maps COMPANY_NOT_FOUND to a pull-it message', () => {
    const presented = presentBoardError("COMPANY_NOT_FOUND: company 'acme' was not found");
    expect(presented.message).toBe(
      "This company isn't available on this device yet — run a sync to pull it",
    );
  });

  it('falls back to a generic retry message for unknown errors, preserving the raw detail', () => {
    const presented = presentBoardError('board HTTP 500: upstream exploded');
    expect(presented.message).toBe('The board could not refresh — try again after a sync');
    expect(presented.detail).toBe('board HTTP 500: upstream exploded');
    expect(presented.authRequired).toBe(false);
  });

  it('stringifies non-string rejections (Tauri rejections are not always strings)', () => {
    const presented = presentBoardError(new Error('AUTH_REQUIRED: board (HTTP 403)'));
    expect(presented.message).toBe('The board could not refresh — try again after a sync');
    expect(presented.detail).toContain('AUTH_REQUIRED');

    expect(presentBoardError(null).detail).toBe('');
    expect(presentBoardError(undefined).message).toBe(
      'The board could not refresh — try again after a sync',
    );
  });

  it('does not classify prefixes that appear mid-string', () => {
    const presented = presentBoardError("board fetch: AUTH_REQUIRED: something");
    expect(presented.message).toBe('The board could not refresh — try again after a sync');
  });
});
