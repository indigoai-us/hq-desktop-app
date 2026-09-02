import { describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open }));

import {
  approvedBrowserUrl,
  approvedExternalUrl,
  openApprovedExternalUrl,
  openBrowserUrl,
} from './external-open';

describe('embedded Work external opener', () => {
  it('normalizes only the approved HTTPS browser handoffs', () => {
    expect(approvedExternalUrl('https://hq.computer')).toBe('https://hq.computer/');
    expect(approvedExternalUrl('https://calendar.google.com')).toBe(
      'https://calendar.google.com/',
    );
    expect(approvedExternalUrl('https://accounts.google.com/o/oauth2/v2/auth')).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(approvedExternalUrl('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(approvedExternalUrl('https://zoom.us/j/123')).toBe('https://zoom.us/j/123');
    expect(approvedExternalUrl('https://us02web.zoom.us/j/123')).toBe(
      'https://us02web.zoom.us/j/123',
    );
  });

  it('allows only the exact macOS notification-settings recovery route', () => {
    expect(approvedExternalUrl('x-apple.systempreferences:com.apple.preference.notifications')).toBe(
      'x-apple.systempreferences:com.apple.preference.notifications',
    );
    for (const raw of [
      'x-apple.systempreferences:com.apple.preference.security',
      'x-apple.systempreferences:com.apple.preference.notifications?x=1',
      'x-apple.systempreferences:com.apple.preference.notifications/',
    ]) {
      expect(() => approvedExternalUrl(raw)).toThrow('not approved');
    }
  });

  it('rejects untrusted schemes, credentials, and lookalike hosts', () => {
    for (const raw of [
      'http://hq.computer',
      'file:///Applications/Calculator.app',
      'https://hq.computer.evil.example',
      'https://evilzoom.us/j/123',
      'https://user@hq.computer',
    ]) {
      expect(() => approvedExternalUrl(raw)).toThrow('not approved');
    }
  });

  it('sends only the validated URL to the Tauri shell', async () => {
    await openApprovedExternalUrl('https://teams.microsoft.com/l/meetup-join/example');

    expect(open).toHaveBeenCalledWith('https://teams.microsoft.com/l/meetup-join/example');
  });

  it('opens credential-free http(s) and mailto chat links in the default browser', async () => {
    expect(approvedBrowserUrl('https://example.com/docs')).toBe(
      'https://example.com/docs',
    );
    expect(approvedBrowserUrl('http://example.com')).toBe('http://example.com/');
    expect(approvedBrowserUrl('mailto:ada@example.com')).toBe(
      'mailto:ada@example.com',
    );
    expect(approvedBrowserUrl('javascript:alert(1)')).toBeNull();
    expect(approvedBrowserUrl('file:///etc/passwd')).toBeNull();
    expect(approvedBrowserUrl('https://user:pass@example.com')).toBeNull();

    await openBrowserUrl('https://example.com/docs');
    expect(open).toHaveBeenCalledWith('https://example.com/docs');
    open.mockClear();
    await openBrowserUrl('javascript:alert(1)');
    expect(open).not.toHaveBeenCalled();
  });
});
