import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('menubar popover routes into V4 desktop surfaces', () => {
  const feed = readRepoFile('src/components/NotificationFeed.svelte');
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('opens new-file notifications in the desktop company Activity screen', () => {
    expect(feed).toContain("invoke('open_desktop_alt_window'");
    expect(feed).toContain('route: `company:${company}:activity`');
    expect(feed).toContain("it.kind === 'new-file'");
    expect(feed).toContain('openCompanyActivity');
    expect(route).toContain("kind === 'company'");
    // company-detail-desktop-ia: deep-links normalize via normalizeCompanyTab
    // (legacy accounts/tasks/library redirects + live CompanyTab ids).
    expect(route).toContain('normalizeCompanyTab(second)');
  });

  it('US-012: quick-window routing is the default only — in-shell overrides win', () => {
    // The popover passes no overrides, so open_desktop_alt_window /
    // open_dm_detail / open_share_detail stay its routing. The desktop Inbox
    // supplies onopendm/onopenshare/onopenworkspace, which are consulted
    // before any quick-window invoke.
    expect(feed).toContain('if (onopendm) {');
    expect(feed).toContain('if (onopenshare) {');
    expect(feed).toContain('if (onopenworkspace) {');
    expect(feed).toContain("invoke('open_dm_detail'");
    expect(feed).toContain("invoke('open_share_detail'");
  });
});
