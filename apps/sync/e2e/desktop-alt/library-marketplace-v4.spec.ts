import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop-alt V4 library and marketplace family (US-014)', () => {
  const libraryPage = readRepoFile('src/desktop-alt/pages/LibraryPage.svelte');
  const libraryBrowser = readRepoFile('src/desktop-alt/components/LibraryBrowser.svelte');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const secondarySidebar = readRepoFile('src/desktop-alt/v4/V4SecondarySidebar.svelte');
  const submit = readRepoFile('src/desktop-alt/panels/SubmitPanel.svelte');
  const marketplace = readRepoFile('src/desktop-alt/panels/MarketplacePanel.svelte');
  const profile = readRepoFile('src/desktop-alt/panels/ProfilePanel.svelte');
  const moderation = readRepoFile('src/desktop-alt/panels/ModerationPanel.svelte');

  it('library renders a card-grid browser with a detail panel', () => {
    expect(libraryPage).toContain('<LibraryBrowser {items} {loading} {error} forcedFilter={tab} />');
    expect(libraryBrowser).toContain('card grid');
    expect(libraryBrowser).toContain('detail slide-over');
    expect(libraryBrowser).toContain('{ id: \'installed\', label: \'Installed\' }');
    expect(libraryBrowser).toContain('{ id: \'marketplace\', label: \'Marketplace\' }');
  });

  it('routes the Publish a pack footer to the real Submit panel', () => {
    expect(desktopApp).toContain("navigate({ kind: 'library', tab: 'submit' })");
    expect(libraryPage).toContain("submit: 'Publish a pack'");
    expect(libraryBrowser).toContain('<SubmitPanel />');
    expect(submit).toContain('data-testid="submit-panel"');
    expect(secondarySidebar).toContain('class:active={footer.active}');
    expect(secondarySidebar).toContain("aria-current={footer.active ? 'page' : undefined}");
  });

  it('marketplace has listings, install/installed states, README preview, and honest published-listing context', () => {
    expect(marketplace).toContain('data-testid="marketplace-card"');
    expect(marketplace).toContain('data-testid="marketplace-install-button"');
    expect(marketplace).toContain('Installed.');
    expect(marketplace).toContain('data-testid="marketplace-readme-preview"');
    expect(marketplace).toContain('README preview');
    expect(marketplace).toContain('data-testid="marketplace-your-listings"');
    expect(marketplace).toContain('PUBLISHED LISTINGS');
    expect(marketplace).not.toContain('Published packs you own');
  });

  it('the browser harness provides deterministic populated marketplace data', () => {
    const mocks = readRepoFile('dev-harness/mocks/core.ts');
    expect(mocks).toContain('list_marketplace_listings: () => MARKETPLACE_LISTINGS');
    expect(mocks).toContain("slug: 'engineering'");
  });

  it('profile includes claim/edit public preview and creator request-access variant lives in moderation', () => {
    expect(profile).toContain('claimCreatorHandle');
    expect(profile).toContain('data-testid="profile-preview"');
    expect(profile).toContain('data-testid="profile-preview-listing"');
    expect(profile).toContain('safeLocalImageSrc');
    expect(profile).toContain('data-testid="profile-avatar-preview-unavailable"');
    expect(profile).toContain('data-testid="profile-preview-avatar-unavailable"');
    expect(moderation).toContain('Creator-access requests');
    expect(moderation).toContain('data-testid="moderation-request-row"');
    expect(moderation).toContain('data-testid="moderation-request-approve"');
    expect(moderation).toContain('data-testid="moderation-request-deny"');
  });

  it('admin moderation queue remains gated and review actions are present', () => {
    expect(moderation).toContain("invoke<boolean>('desktop_alt_is_admin')");
    expect(moderation).toContain('data-testid="moderation-locked"');
    expect(moderation).toContain('data-testid="moderation-queue-section"');
    expect(moderation).toContain('data-testid="moderation-approve"');
    expect(moderation).toContain('data-testid="moderation-reject"');
  });
});

describe('desktop-alt V2 library — marketplace fold-in and retained moderation (US-015)', () => {
  const routeTs = readRepoFile('src/desktop-alt/route.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const libraryPage = readRepoFile('src/desktop-alt/pages/LibraryPage.svelte');
  const libraryBrowser = readRepoFile('src/desktop-alt/components/LibraryBrowser.svelte');
  const marketplace = readRepoFile('src/desktop-alt/panels/MarketplacePanel.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('the Library sub-nav carries a Marketplace entry between Workers and Installed', () => {
    expect(routeTs).toContain("{ id: 'marketplace', label: 'Marketplace' }");
    expect(routeTs).toContain(
      "export type LibraryTab = 'skills' | 'workers' | 'marketplace' | 'installed' | 'submit' | 'profile'",
    );
  });

  it('the Library marketplace tab renders the full existing install pipeline', () => {
    expect(libraryPage).toContain("marketplace: 'Marketplace'");
    expect(libraryBrowser).toContain('<MarketplacePanel />');
    // Browse → detail → install-scope selection → install log, unchanged.
    expect(marketplace).toContain('data-testid="marketplace-card"');
    expect(marketplace).toContain('data-testid="marketplace-detail-panel"');
    expect(marketplace).toContain('data-testid="marketplace-scope-select"');
    expect(marketplace).toContain('data-testid="marketplace-install-log"');
  });

  it('marketplace stays palette-reachable while absent from the V2 sidebar GENERAL group', () => {
    expect(desktopApp).toContain("id: 'command-go-marketplace'");
    expect(model).toContain("V4_NAV_ITEMS.filter((item) => item.id !== 'marketplace')");
  });

  it('moderation is retained, admin-gated, and palette-only (no sidebar entry)', () => {
    expect(desktopApp).toContain("id: 'command-go-moderation'");
    expect(desktopApp).toContain("invoke<boolean>('desktop_alt_is_admin')");
    // Palette-only: neither sidebar nav model carries a moderation row.
    expect(model).not.toContain("id: 'moderation'");
  });
});
