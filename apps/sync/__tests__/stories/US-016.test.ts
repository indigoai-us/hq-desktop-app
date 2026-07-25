import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopApp = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'),
  'utf8',
);
const commandPalette = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/components/CommandPalette.svelte'),
  'utf8',
);
const statusBar = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/DesktopStatusBar.svelte'),
  'utf8',
);
const banner = readFileSync(
  resolve(process.cwd(), 'src/components/BannerNotification.svelte'),
  'utf8',
);
const homePage = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/pages/HomePage.svelte'),
  'utf8',
);
const meetingsPage = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/pages/MeetingsPage.svelte'),
  'utf8',
);
const liveNowCard = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/components/LiveNowCard.svelte'),
  'utf8',
);
const messagesShell = readFileSync(
  resolve(process.cwd(), 'src/components/messaging/MessagesShell.svelte'),
  'utf8',
);
const marketplacePanel = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/panels/MarketplacePanel.svelte'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-016: V4 connective tissue stays complete', () => {
  it('renders first-load skeletons and empty states across the main V4 surfaces', () => {
    expect(homePage).toContain('class="home-skeleton"');
    expect(homePage).toContain('aria-busy="true"');
    // (CompaniesPage was removed as a destination by hq-desktop-widget US-007.)
    expect(messagesShell).toContain('Loading conversations');
    expect(messagesShell).toContain('class="pane-empty"');
    expect(liveNowCard).toContain('No active meeting window has been detected.');
    expect(meetingsPage).toContain('No calendars connected yet');
    expect(marketplacePanel).toContain('class="grid-skeleton"');
    expect(marketplacePanel).toContain('data-testid="marketplace-empty"');
  });

  it('keeps banner notifications source-agnostic with click, action, and dismiss affordances', () => {
    expect(banner).toContain('kind: string;');
    expect(banner).toContain('actionLabel?: string | null;');
    expect(banner).toContain('actionId?: string | null;');
    expect(banner).toContain('clickActionId: string;');
    expect(banner).toContain("listen<BannerPayload>('banner:event'");
    expect(banner).toContain("invoke('banner_window_ready')");
    expect(banner).toContain("invoke('banner_action', { action: actionId, payload })");
    expect(banner).toContain("invoke('dismiss_banner')");
    expect(banner).toContain('data-kind={payload.kind}');
    expect(banner).toContain('{payload.actionLabel}');
  });

  it('groups cmd-K into ACTIONS and NAVIGATE and includes company section destinations', () => {
    const app = normalize(desktopApp);
    const palette = normalize(commandPalette);

    expect(desktopApp).toContain('COMPANY_SECTIONS');
    // US-007: the palette iterates the sidebar-ordered (connected-first) rows.
    expect(desktopApp).toContain('orderedCompanies.flatMap((row, index) => [');
    expect(desktopApp).toContain('label: `Go to ${row.label} ${section.label}`');
    expect(desktopApp).toContain("action: () => navigate({ kind: 'company', slug: row.slug, tab: section.id })");

    expect(commandPalette).toContain("label: 'ACTIONS'");
    expect(commandPalette).toContain("label: 'NAVIGATE'");
    expect(commandPalette).toContain("return command.id.startsWith('command-go-') ? 'navigate' : 'actions';");
    expect(palette).toContain('{#each commandSections as section (section.id)}');
    expect(palette).toContain('<div class="command-section-title">{section.label}</div>');
    expect(app).toContain("label: 'Sync now'");
    expect(app).toContain("label: 'Go to Marketplace'"); // Companies page removed (US-007)
  });

  it('DESKTOP-001: compact shell removes the bottom status bar and keeps titlebar chrome', () => {
    // Status bar component still exists (version popout host) but is unmounted.
    expect(statusBar).toContain('filesProgressed?: number;');
    expect(statusBar).toContain('workspaceCount?: number;');
    expect(desktopApp).not.toContain('<DesktopStatusBar');
    expect(desktopApp).toContain('<V4TitleBar');
    expect(desktopApp).toContain('ontogglesidebar={handleToggleSidebar}');
    expect(desktopApp).toContain('oncommand={handleOpenCommandPalette}');
    expect(desktopApp).toContain('onaccount={handleAccountMenu}');
  });
});
