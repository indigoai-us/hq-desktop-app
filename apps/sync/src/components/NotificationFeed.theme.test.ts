import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const feed = readFileSync(new URL('./NotificationFeed.svelte', import.meta.url), 'utf8');
// The compact feed rows (avatar / glyph chip, title, relative time, unread dot,
// preview) were promoted to the global popover stylesheet in the
// notifications-first redesign so the popover's synthetic system-notice rows and
// these data rows render identically. Assert the shared row tokens there.
const popoverCss = readFileSync(new URL('../styles/popover.css', import.meta.url), 'utf8');

describe('NotificationFeed popover theme tokens', () => {
  it('uses shared adaptive popover tokens for feed surfaces and text', () => {
    // Shared row styles ride the adaptive --pop-* / --popover-* tokens (never
    // hardcoded per-theme colors) so the feed follows the OS appearance.
    expect(popoverCss).toContain('.notif-row');
    expect(popoverCss).toContain('.notif-gly');
    expect(popoverCss).toContain('color: var(--pop-text);');
    expect(popoverCss).toContain('color: var(--pop-muted);');
    expect(popoverCss).toContain('background: var(--pop-hover);');
    expect(popoverCss).toContain('var(--popover-unread)');

    // Feed-specific styles that stay scoped to the component still use the
    // shared adaptive aliases rather than fixed colors.
    expect(feed).toContain('color: var(--popover-text-muted);');
    expect(feed).toContain('color: var(--popover-danger);');
    expect(feed).toContain('background: var(--popover-action-hover);');
    expect(feed).toContain('color: var(--popover-text);');
  });

  it('does not reintroduce the dark-only notification feed palette', () => {
    // The component must not hardcode the retired dark-only feed colors — light
    // + dark are driven entirely by the shared tokens.
    expect(feed).not.toMatch(/rgba\(255,\s*255,\s*255,\s*0\.0[45]\)/);
    for (const hex of ['#8a8a90', '#8a8a92', '#f0a3a3', '#f2f2f4', '#b9b9c0', '#76767c', '#c2c2c8']) {
      expect(feed).not.toContain(hex);
    }
  });
});
