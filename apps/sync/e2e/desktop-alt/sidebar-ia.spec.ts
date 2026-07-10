import { describe, expect, it } from 'vitest';
import {
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  resolvePendingDesktopRoute,
  fromV4Route,
  LIBRARY_SECTIONS,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import { V4_NAV_ITEMS } from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-006 — US-007 sidebar IA (behavioral route helpers + source contracts).
 *
 * Locks the V4 primary-nav shape and landing rules:
 *  - ⌘1–⌘4 = Inbox / Meetings / Marketplace / Library; company digits map
 *    connected-first order.
 *  - Legacy intents resolve (messages/notifications → inbox, home/sync → home,
 *    mission-control palette-only, library:marketplace → top-level marketplace).
 *  - getDesktopLandingRoute uses last-visited company then first sidebar row.
 *  - Source: no Home / Mission Control / Companies primary rows; Marketplace
 *    is top-level; Library secondary tabs drop Marketplace; last-company key.
 */

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

function hotkey(key: string): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'> {
  return { key, metaKey: true, ctrlKey: false };
}

describe('US-006 / US-007: sidebar IA — hotkeys (behavioral)', () => {
  it("⌘1 → inbox, ⌘3 → marketplace", () => {
    const companies = [workspace({})];
    expect(getDesktopHotkeyRoute(hotkey('1'), companies)).toEqual({ kind: 'inbox' });
    expect(getDesktopHotkeyRoute(hotkey('3'), companies)).toEqual({ kind: 'marketplace' });
    expect(getDesktopHotkeyRoute(hotkey('2'), companies)).toEqual({ kind: 'meetings' });
    expect(getDesktopHotkeyRoute(hotkey('4'), companies)).toEqual({ kind: 'library' });
  });

  it('company digits map into connected-first sidebar order', () => {
    // Connected (synced) first, then local-only; alpha within groups.
    const companies = [
      workspace({ slug: 'zebra', displayName: 'Zebra', state: 'local-only' }),
      workspace({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
      workspace({ slug: 'beta', displayName: 'Beta', state: 'synced' }),
    ];
    // ⌘5 = first connected company (Acme before Beta alphabetically).
    expect(getDesktopHotkeyRoute(hotkey('5'), companies)).toEqual({
      kind: 'company',
      slug: 'acme',
    });
    expect(getDesktopHotkeyRoute(hotkey('6'), companies)).toEqual({
      kind: 'company',
      slug: 'beta',
    });
    expect(getDesktopHotkeyRoute(hotkey('7'), companies)).toEqual({
      kind: 'company',
      slug: 'zebra',
    });
  });
});

describe('US-006 / US-007: sidebar IA — legacy intent resolution (behavioral)', () => {
  it("messages / notifications → inbox", () => {
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'inbox' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
  });

  it("home / sync → home; mission-control stays reachable", () => {
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('sync')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({
      kind: 'mission-control',
    });
  });

  it("legacy library:marketplace alias → top-level marketplace", () => {
    expect(resolvePendingDesktopRoute('library:marketplace')).toEqual({
      kind: 'marketplace',
    });
    expect(resolvePendingDesktopRoute('marketplace')).toEqual({ kind: 'marketplace' });
  });
});

describe('US-006 / US-007: sidebar IA — landing route (behavioral)', () => {
  it('returns last-visited company when it still exists', () => {
    const companies = [
      workspace({ slug: 'acme', displayName: 'Acme' }),
      workspace({ slug: 'indigo', displayName: 'Indigo' }),
    ];
    expect(getDesktopLandingRoute(companies, 'indigo')).toEqual({
      kind: 'company',
      slug: 'indigo',
    } satisfies DesktopRoute);
  });

  it('falls back to first sidebar company when last-visited is missing', () => {
    const companies = [
      workspace({ slug: 'zebra', displayName: 'Zebra', state: 'local-only' }),
      workspace({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
    ];
    // Connected-first → Acme is first row.
    expect(getDesktopLandingRoute(companies, 'gone')).toEqual({
      kind: 'company',
      slug: 'acme',
    });
    expect(getDesktopLandingRoute(companies, null)).toEqual({
      kind: 'company',
      slug: 'acme',
    });
  });

  it('falls back to home when there are no companies', () => {
    expect(getDesktopLandingRoute([], 'anything')).toEqual({ kind: 'home' });
  });
});

describe('US-006 / US-007: sidebar IA — source contracts', () => {
  it('primary nav has Marketplace and no Home / Mission Control / Companies rows', () => {
    const navIds = V4_NAV_ITEMS.map((item) => item.id);
    expect(navIds).toEqual(['inbox', 'meetings', 'marketplace', 'library', 'files']);
    expect(navIds).not.toContain('home');
    expect(navIds).not.toContain('mission-control');
    expect(navIds).not.toContain('companies');

    const model = readRepoFile('src/desktop-alt/v4/model.ts');
    expect(model).toContain("{ id: 'marketplace', label: 'Marketplace' }");
    expect(model).toContain("{ id: 'inbox', label: 'Inbox' }");

    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    // Comment contract: US-007 removed Home / Mission Control / Companies page rows.
    expect(sidebar).toContain(
      'US-007 removed Home / Mission Control / Companies page rows',
    );
    // Companies is a section label for company rows, not a primary nav destination.
    expect(sidebar).toContain('id="v4-companies-label">Companies</div>');
  });

  it('Library secondary tabs no longer include Marketplace', () => {
    expect(LIBRARY_SECTIONS.map((s) => s.id)).toEqual([
      'skills',
      'workers',
      'installed',
      'profile',
    ]);
    expect(LIBRARY_SECTIONS.map((s) => s.id)).not.toContain('marketplace');

    const route = readRepoFile('src/desktop-alt/route.ts');
    expect(route).toContain("Marketplace is top-level now (US-007), not a Library tab");

    const libraryPage = readRepoFile('src/desktop-alt/pages/LibraryPage.svelte');
    expect(libraryPage).toContain(
      'Skills / Workers / Installed / Profile tabs (Marketplace is',
    );
    expect(libraryPage).toContain('top-level now — US-007)');
  });

  it('landing persistence key lives in DesktopApp', () => {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain("const LAST_COMPANY_CACHE_KEY = 'hq-sync.desktop.last-company.v1'");
  });
});
