import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const popoverSource = readFileSync(
  resolve(process.cwd(), 'src/components/Popover.svelte'),
  'utf8',
);
const feedSource = readFileSync(
  resolve(process.cwd(), 'src/components/NotificationFeed.svelte'),
  'utf8',
);
const appSource = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-004 / US-001: chrome-free menubar notification panel', () => {
  it('removes desktop-view CTA, header chrome, and tabs from the popover', () => {
    const compactSource = normalize(popoverSource);

    // Desktop-view toggle left the menubar (US-001); launcher returns in US-005.
    expect(compactSource).not.toContain('data-testid="desktop-alt-toggle"');
    expect(compactSource).not.toContain('class="mbp-foot"');
    expect(compactSource).not.toContain('Open desktop view');
    expect(compactSource).not.toContain('class="mbp-head"');
    expect(compactSource).not.toContain('data-testid="popover-settings-gear"');
    expect(compactSource).not.toContain('data-testid="popover-overflow-button"');
    expect(compactSource).not.toContain('data-testid="popover-sync-button"');
    expect(compactSource).not.toContain('class="mbp-tabs"');
    expect(compactSource).not.toContain('class="header-icon-button desktop-alt-toggle"');
    expect(compactSource).not.toContain('<button class="footer-action" onclick={onsettings}>');
  });

  it('keeps open_desktop_alt_window available via NotificationFeed deep-links', () => {
    const invokeMatches = feedSource.match(/invoke\('open_desktop_alt_window'/g) ?? [];
    expect(invokeMatches.length).toBeGreaterThanOrEqual(1);
    expect(appSource).toContain("invoke('open_desktop_alt_window')");
  });

  it('never gates the popover DOM on desktopAltEnabled', () => {
    expect(popoverSource).not.toContain('desktopAltEnabled');
    expect(popoverSource).not.toContain('data-testid="desktop-alt-toggle"');
  });

  it('keeps status + notifications body as the panel surface', () => {
    const compactSource = normalize(popoverSource);

    expect(compactSource).toContain('data-testid="popover-status-row"');
    expect(compactSource).toContain('id="popover-notifications-label"');
    expect(compactSource).toContain('Mark all read');
    expect(compactSource).toContain('<NotificationFeed');
    expect(compactSource).toContain('class="mbp-unread-count"');
  });

  it('does not host desktop-alt open failures as an inline notice (chrome removed)', () => {
    const compactSource = normalize(popoverSource);

    expect(compactSource).not.toContain("showDesktopAltError('Could not open desktop view.')");
    expect(compactSource).not.toContain('desktopAltError');
  });
});
