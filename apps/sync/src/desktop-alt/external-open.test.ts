import { describe, expect, it, vi } from 'vitest';

const open = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@tauri-apps/plugin-shell', () => ({ open }));

import { approvedExternalUrl, openApprovedExternalUrl } from './external-open';

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
});
