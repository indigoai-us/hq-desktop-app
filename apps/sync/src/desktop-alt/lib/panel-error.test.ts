import { describe, expect, it } from 'vitest';
import { presentPanelError } from './panel-error';

describe('presentPanelError', () => {
  it('maps AUTH_REQUIRED rejections to a sign-in message for any surface', () => {
    const presented = presentPanelError(
      'AUTH_REQUIRED: secrets (HTTP 401 Unauthorized)',
      { surface: 'secrets' },
    );
    expect(presented.message).toBe('Session expired — sign in again');
    expect(presented.authRequired).toBe(true);
    expect(presented.detail).toBe('AUTH_REQUIRED: secrets (HTTP 401 Unauthorized)');
  });

  it('maps COMPANY_NOT_CONNECTED to a calm cloud message', () => {
    const presented = presentPanelError(
      "COMPANY_NOT_CONNECTED: company 'acme' is not connected to cloud",
      { surface: 'deployments' },
    );
    expect(presented.message).toBe("This company isn't connected to cloud yet");
    expect(presented.authRequired).toBe(false);
  });

  it('maps COMPANY_NOT_SYNCED (memberships-miss variant) to a reconnect message, hiding the raw diagnostic', () => {
    const raw =
      "COMPANY_NOT_SYNCED: company 'acme' is not synced: manifest cloud_uid cmp_old not found in your cloud memberships";
    const presented = presentPanelError(raw, { surface: 'activity' });
    expect(presented.message).toBe(
      'This company needs to be reconnected — open the menubar and sync',
    );
    // The internal diagnostic must never surface as the primary line…
    expect(presented.message).not.toMatch(/cloud_uid|manifest/);
    // …but stays available for logs.
    expect(presented.detail).toBe(raw);
  });

  it('maps COMPANY_NOT_FOUND to a pull-it message', () => {
    const presented = presentPanelError(
      "COMPANY_NOT_FOUND: company 'acme' was not found",
      { surface: 'secrets' },
    );
    expect(presented.message).toBe(
      "This company isn't available on this device yet — run a sync to pull it",
    );
  });

  it('falls back to a generic surface-specific retry line for unknown errors, preserving the raw detail', () => {
    const presented = presentPanelError('secrets HTTP 500: upstream exploded', {
      surface: 'secrets',
    });
    expect(presented.message).toBe('Couldn’t load secrets — try again after a sync');
    expect(presented.detail).toBe('secrets HTTP 500: upstream exploded');
    expect(presented.authRequired).toBe(false);
  });

  it('lets a caller override the generic fallback line entirely', () => {
    const presented = presentPanelError('pick_folder: dialog dismissed by OS', {
      surface: 'settings',
      fallback: 'Couldn’t open the folder picker — try again',
    });
    expect(presented.message).toBe('Couldn’t open the folder picker — try again');
    expect(presented.detail).toBe('pick_folder: dialog dismissed by OS');
  });

  it('still maps well-known codes even when a custom fallback is supplied', () => {
    const presented = presentPanelError('AUTH_REQUIRED: settings (HTTP 401)', {
      surface: 'settings',
      fallback: 'Couldn’t open the folder picker — try again',
    });
    expect(presented.message).toBe('Session expired — sign in again');
    expect(presented.authRequired).toBe(true);
  });

  it('stringifies non-string rejections (Tauri rejections are not always strings)', () => {
    const presented = presentPanelError(new Error('AUTH_REQUIRED: secrets (HTTP 403)'), {
      surface: 'secrets',
    });
    expect(presented.message).toBe('Couldn’t load secrets — try again after a sync');
    expect(presented.detail).toContain('AUTH_REQUIRED');

    expect(presentPanelError(null, { surface: 'secrets' }).detail).toBe('');
    expect(presentPanelError(undefined, { surface: 'activity' }).message).toBe(
      'Couldn’t load activity — try again after a sync',
    );
  });

  it('does not classify prefixes that appear mid-string', () => {
    const presented = presentPanelError('secrets fetch: AUTH_REQUIRED: something', {
      surface: 'secrets',
    });
    expect(presented.message).toBe('Couldn’t load secrets — try again after a sync');
    expect(presented.authRequired).toBe(false);
  });
});
