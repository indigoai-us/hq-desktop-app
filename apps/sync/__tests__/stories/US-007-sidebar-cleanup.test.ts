// US-007: Desktop sidebar cleanup — hide Home + Mission Control, remove the
// Companies page, promote Marketplace top-level, land on the last-visited
// company (persisted) with a first-company fallback, and rebalance ⌘1..N.
// Pure-model tests drive the route/sidebar derivations; source contracts lock
// the DesktopApp wiring (landing init, persistence key, mount branches).
// Leave __tests__/stories/US-007.test.ts alone — legacy suite from an older project.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  fromV4Route,
  getDesktopCompanies,
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  getDesktopRouteKey,
  getDesktopSecondarySidebar,
  LIBRARY_SECTIONS,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { getV4SidebarModel, V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const desktopApp = readFileSync(root('src/desktop-alt/DesktopApp.svelte'), 'utf8');
const marketplacePage = readFileSync(
  root('src/desktop-alt/pages/MarketplacePage.svelte'),
  'utf8',
);

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_1',
    bucketName: 'bucket',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const workspaces: Workspace[] = [
  workspace({ slug: 'indigo', displayName: 'Indigo' }),
  workspace({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
  workspace({ slug: 'local-co', displayName: 'Local Co', state: 'local-only', cloudUid: null }),
];

describe('US-007: sidebar has no Home / Mission Control / Companies rows and lands on a company', () => {
  it('renders only Messages / Notifications / Meetings / Marketplace / Library / Files nav rows', () => {
    expect(V4_NAV_ITEMS.map((item) => item.label)).toEqual([
      'Messages',
      'Notifications',
      'Meetings',
      'Marketplace',
      'Library',
      'Files',
    ]);
    for (const gone of ['Home', 'Mission Control', 'Companies']) {
      expect(V4_NAV_ITEMS.some((item) => item.label === gone)).toBe(false);
    }
  });

  it('lands a fresh desktop on the first sidebar company row (connected-first order)', () => {
    // No persisted slug → the first rendered company row: Acme (alpha within
    // the connected group) leads Indigo; the local-only row trails both.
    expect(getDesktopLandingRoute(workspaces, null)).toEqual({ kind: 'company', slug: 'acme' });
    // A workspace-less install falls back to Home, the palette-only exception surface.
    expect(getDesktopLandingRoute([], null)).toEqual({ kind: 'home' });
    // DesktopApp seeds its route state from the landing helper + the slug
    // persisted by the previous session (frozen at startup).
    expect(desktopApp).toContain('const initialLastCompanySlug = readLastCompanySlug()');
    expect(desktopApp).toContain(
      'getDesktopLandingRoute(cachedWorkspaces, initialLastCompanySlug)',
    );
  });

  it('Home and Mission Control stay reachable via the command palette only — no hotkey slots', () => {
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'mission-control' });
    const companies = getDesktopCompanies(workspaces);
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const routed = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(routed?.kind).not.toBe('home');
      expect(routed?.kind).not.toBe('mission-control');
    }
    expect(desktopApp).toContain("id: 'command-go-home'");
    expect(desktopApp).toContain("id: 'command-go-mission-control'");
    // Their palette entries carry no ⌘ shortcut anymore.
    const homeEntry = desktopApp.slice(
      desktopApp.indexOf("id: 'command-go-home'"),
      desktopApp.indexOf("id: 'command-go-mission-control'"),
    );
    expect(homeEntry).not.toContain('shortcut');
  });

  it('the Companies page is gone as a destination', () => {
    expect(resolvePendingDesktopRoute('companies')).toBeNull();
    // The V4 payload narrowing no longer produces a companies kind either.
    expect(fromV4Route({ kind: 'companies' })).toEqual({ kind: 'home' });
    expect(desktopApp).not.toContain('CompaniesPage');
    expect(desktopApp).not.toContain("route.kind === 'companies'");
    expect(desktopApp).not.toContain("id: 'command-go-companies'");
  });
});

describe('US-007: last-visited company landing (persisted)', () => {
  it('lands on company B when B was the last visited and still exists', () => {
    expect(getDesktopLandingRoute(workspaces, 'indigo')).toEqual({
      kind: 'company',
      slug: 'indigo',
    });
    // A stale slug (workspace removed) falls back to the first company row.
    expect(getDesktopLandingRoute(workspaces, 'ghost')).toEqual({
      kind: 'company',
      slug: 'acme',
    });
  });

  it('DesktopApp persists the visited company and re-resolves landing after the real workspace load', () => {
    // Persistence key + write effect, gated on explicit navigation so a
    // fallback auto-landing can never clobber the real last-visited slug.
    expect(desktopApp).toContain("'hq-sync.desktop.last-company.v1'");
    expect(desktopApp).toContain("route.kind === 'company' && userNavigated");
    expect(desktopApp).toContain('window.localStorage.setItem(LAST_COMPANY_CACHE_KEY, route.slug)');
    // Cache-based landings re-resolve exactly once when the live workspace
    // list arrives, without clobbering an explicit navigation.
    expect(desktopApp).toContain('!userNavigated && !landingResolved');
    expect(desktopApp).toContain(
      'getDesktopLandingRoute(result.workspaces, initialLastCompanySlug)',
    );
  });
});

describe('US-007: Marketplace is a top-level destination', () => {
  it('has a sidebar row, the ⌘4 hotkey, and its own route key', () => {
    expect(V4_NAV_ITEMS.some((item) => item.id === 'marketplace')).toBe(true);
    expect(
      getDesktopHotkeyRoute(
        { key: '4', metaKey: true, ctrlKey: false },
        getDesktopCompanies(workspaces),
      ),
    ).toEqual({ kind: 'marketplace' });
    expect(fromV4Route({ kind: 'marketplace' })).toEqual({ kind: 'marketplace' });
    expect(getDesktopRouteKey({ kind: 'marketplace' })).toBe('marketplace');
    // Exactly one active row when the Marketplace route is on screen.
    const model = getV4SidebarModel({ kind: 'marketplace' }, workspaces);
    expect(model.nav.filter((row) => row.active).map((row) => row.id)).toEqual(['marketplace']);
  });

  it('mounts the marketplace surface as a full page (no secondary sidebar)', () => {
    expect(desktopApp).toContain("route.kind === 'marketplace'");
    expect(desktopApp).toContain('<MarketplacePage />');
    expect(marketplacePage).toContain('MarketplacePanel');
    expect(getDesktopSecondarySidebar({ kind: 'marketplace' }, workspaces)).toBeNull();
  });

  it('left the Library tabs, and the legacy library:marketplace intent redirects top-level', () => {
    expect(LIBRARY_SECTIONS.map((section) => section.id)).toEqual([
      'skills',
      'workers',
      'installed',
      'profile',
    ]);
    const library = getDesktopSecondarySidebar({ kind: 'library' }, workspaces);
    expect(library?.items.some((item) => item.label === 'Marketplace')).toBe(false);
    expect(resolvePendingDesktopRoute('library:marketplace')).toEqual({ kind: 'marketplace' });
    expect(resolvePendingDesktopRoute('marketplace')).toEqual({ kind: 'marketplace' });
  });
});

describe('US-007: hotkeys and palette rebalance with no dead slots', () => {
  it('⌘1..⌘5 cover the five primaries and ⌘6..⌘9 cover companies in sidebar order', () => {
    const companies = getDesktopCompanies([
      ...workspaces,
      workspace({ slug: 'zed', displayName: 'Zed', state: 'synced' }),
    ]);
    const meta = (key: string) =>
      getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
    expect(meta('1')).toEqual({ kind: 'messages' });
    expect(meta('2')).toEqual({ kind: 'notifications' });
    expect(meta('3')).toEqual({ kind: 'meetings' });
    expect(meta('4')).toEqual({ kind: 'marketplace' });
    expect(meta('5')).toEqual({ kind: 'library' });
    // Connected-first + alpha: Acme, Indigo, Zed, then the local-only row.
    expect(meta('6')).toEqual({ kind: 'company', slug: 'acme' });
    expect(meta('7')).toEqual({ kind: 'company', slug: 'indigo' });
    expect(meta('8')).toEqual({ kind: 'company', slug: 'zed' });
    expect(meta('9')).toEqual({ kind: 'company', slug: 'local-co' });
  });
});
