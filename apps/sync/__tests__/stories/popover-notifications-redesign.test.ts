import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Source-contract assertions for the notifications-first popover redesign
// (the hq-popup-redesign prototype). These lock the structural intent so a
// dropped wire fails fast without a macOS Tauri build:
//   - native macOS segmented control replaces the old tab pills,
//   - system notices (membership / update / conflict / errors) fold INTO the
//     notifications feed as pinned rows instead of a separate banner stack,
//     with the segmented-control badge counting them alongside unread items,
//   - the header drops the standalone Settings gear (Settings lives in More),
//   - sync progress inlines into the status row,
//   - the More menu carries Phosphor icons + a version/update row,
//   - Settings switches are iOS-green and the release channel uses the shared
//     segmented control.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const normalize = (s: string) => s.replace(/\s+/g, ' ');

const popover = read('src/components/Popover.svelte');
const settings = read('src/components/Settings.svelte');
const popoverCss = read('src/styles/popover.css');
const icon = read('src/components/PopoverIcon.svelte');
const feed = read('src/components/NotificationFeed.svelte');

describe('notifications-first popover redesign', () => {
  it('uses the native macOS segmented control and retires the legacy tab pills', () => {
    const p = normalize(popover);
    expect(p).toContain('<div class="mbp-segbar">');
    expect(p).toContain('<div class="seg-track" role="tablist"');
    expect(p).toContain('class="seg"');
    expect(p).toContain('class="seg-badge"');
    // The old .mbp-tab pill markup + styles are gone.
    expect(popover).not.toContain('class="mbp-tab"');
    expect(popover).not.toContain('mbp-tab-badge');
    // Shared segmented-control styles live globally so Settings can reuse them.
    expect(popoverCss).toContain('.seg-track {');
    expect(popoverCss).toContain('.seg.active {');
    expect(popoverCss).toContain('--seg-sel-shadow');
  });

  it('folds system notices into the feed as pinned rows (no banner stack)', () => {
    const p = normalize(popover);
    // Membership + update + desktop-alt error render as feed rows with glyphs.
    expect(p).toContain('class="notif-gly action"');
    expect(p).toContain('class="notif-gly alert"');
    expect(p).toContain('{membershipNoticeTitle}');
    expect(p).toContain('Update available');
    expect(p).toContain('Sync now');
    // The legacy banner stack is gone.
    expect(popover).not.toContain('class="mbp-notices"');
    expect(popover).not.toContain('class="mbp-banner"');
    // Feed suppresses its empty state while system notices are pinned above it.
    expect(p).toContain('hideEmptyState={hasSystemNotices}');
    expect(feed).toContain('hideEmptyState');
  });

  it('counts system notices toward the segmented-control badge', () => {
    const p = normalize(popover);
    expect(p).toContain('const systemNoticeCount = $derived(');
    expect(p).toContain('const notifBadge = $derived(unreadCount + systemNoticeCount)');
    expect(p).toContain('{notifBadge > 99 ? \'99+\' : notifBadge}');
  });

  it('drops the standalone header gear and inlines sync progress', () => {
    const p = normalize(popover);
    expect(popover).not.toContain('data-testid="popover-settings-gear"');
    // Inline progress meter in the status row; the separate progress block is gone.
    expect(p).toContain('class="mbp-s2 prog"');
    expect(p).toContain('class="mbp-bar"');
    expect(p).toContain('class="mbp-pct"');
    expect(popover).not.toContain('class="mbp-progress"');
  });

  it('gives the More menu Phosphor icons and a version/update row', () => {
    const p = normalize(popover);
    expect(p).toContain('class="mbp-menu-ver"');
    expect(p).toContain('class="mv-name"');
    expect(p).toContain('class="mv-btn"');
    expect(p).toContain('<PopoverIcon name="gear"');
    expect(p).toContain('<PopoverIcon name="sign-out"');
    expect(p).toContain('<PopoverIcon name="power"');
  });

  it('ships the inlined Phosphor icon set used across the popover', () => {
    for (const name of [
      'dots-three', 'arrows-clockwise', 'check', 'cloud-arrow-down', 'files',
      'video-camera', 'warning', 'download-simple', 'gear',
      'clock-counter-clockwise', 'sign-out', 'power', 'laptop', 'bell',
    ]) {
      expect(icon).toContain(`'${name}'`);
    }
  });

  it('makes Settings switches iOS-green and reuses the shared segmented control', () => {
    const s = normalize(settings);
    expect(settings).toContain('var(--switch-on');
    expect(settings).toContain('var(--switch-off');
    // Release-channel picker uses the shared .seg-track / .seg classes.
    expect(s).toContain('class="seg-track channel-segments"');
    expect(s).toContain('class="seg"');
    expect(popoverCss).toContain('--switch-on');
  });
});
