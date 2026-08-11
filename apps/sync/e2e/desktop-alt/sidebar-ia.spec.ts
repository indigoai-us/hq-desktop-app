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
 * US-006 — US-007 sidebar IA (behavioral route helpers + source contracts),
 * updated for hq-desktop-v2 US-002 single-active-workspace hotkeys.
 *
 * Locks the V4 primary-nav shape and landing rules:
 *  - ⌘1–⌘9 = non-personal companies in connected-first order; ⌘0 = Personal.
 *  - Legacy intents resolve (messages → Messages, notifications → Inbox,
 *    home/sync → home,
 *    mission-control palette-only, library:marketplace → Library marketplace tab, US-015).
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

describe('US-006 / US-007 / US-002: sidebar IA — hotkeys (behavioral)', () => {
  it('⌘1 → first company; keys past the company count stay quiet', () => {
    const companies = [workspace({})];
    expect(getDesktopHotkeyRoute(hotkey('1'), companies)).toEqual({
      kind: 'company',
      slug: 'indigo',
    });
    expect(getDesktopHotkeyRoute(hotkey('2'), companies)).toBeNull();
    expect(getDesktopHotkeyRoute(hotkey('3'), companies)).toBeNull();
  });

  it('company digits map into connected-first sidebar order', () => {
    // Connected (synced) first, then local-only; alpha within groups.
    const companies = [
      workspace({ slug: 'zebra', displayName: 'Zebra', state: 'local-only' }),
      workspace({ slug: 'acme', displayName: 'Acme', state: 'synced' }),
      workspace({ slug: 'beta', displayName: 'Beta', state: 'synced' }),
    ];
    // ⌘1 = first connected company (Acme before Beta alphabetically).
    expect(getDesktopHotkeyRoute(hotkey('1'), companies)).toEqual({
      kind: 'company',
      slug: 'acme',
    });
    expect(getDesktopHotkeyRoute(hotkey('2'), companies)).toEqual({
      kind: 'company',
      slug: 'beta',
    });
    expect(getDesktopHotkeyRoute(hotkey('3'), companies)).toEqual({
      kind: 'company',
      slug: 'zebra',
    });
  });
});

describe('US-006 / US-007: sidebar IA — legacy intent resolution (behavioral)', () => {
  it("messages → Messages; notifications → Inbox", () => {
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'inbox' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'inbox' });
  });

  it("home / sync → home; mission-control stays reachable", () => {
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('sync')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({
      kind: 'mission-control',
    });
  });

  it("library:marketplace routes to the Library marketplace tab (US-015 fold-in)", () => {
    expect(resolvePendingDesktopRoute('library:marketplace')).toEqual({
      kind: 'library',
      tab: 'marketplace',
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
    expect(navIds).toEqual(['inbox', 'messages', 'meetings', 'marketplace', 'library', 'files']);
    expect(navIds).not.toContain('home');
    expect(navIds).not.toContain('mission-control');
    expect(navIds).not.toContain('companies');

    const model = readRepoFile('src/desktop-alt/v4/model.ts');
    expect(model).toContain("{ id: 'marketplace', label: 'Marketplace' }");
    expect(model).toContain("{ id: 'inbox', label: 'Inbox' }");
    expect(model).toContain("{ id: 'messages', label: 'Messages' }");

    const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
    // Comment contract: US-007 removed Home / Mission Control / Companies page rows.
    expect(sidebar).toContain('US-007 removed Home / Mission');
    expect(sidebar).toContain('Control / Companies page rows');
    // Companies is a section label for company rows, not a primary nav destination.
    expect(sidebar).toContain('id="v4-companies-label">Companies</div>');
  });

  it('Library secondary tabs include the Marketplace fold-in entry (US-015)', () => {
    expect(LIBRARY_SECTIONS.map((s) => s.id)).toEqual([
      'skills',
      'workers',
      'marketplace',
      'installed',
      'profile',
    ]);

    const route = readRepoFile('src/desktop-alt/route.ts');
    expect(route).toContain('Marketplace is folded back into the Library sub-nav (US-015)');

    const libraryPage = readRepoFile('src/desktop-alt/pages/LibraryPage.svelte');
    expect(libraryPage).toContain(
      'Skills / Workers / Marketplace / Installed / Profile tabs',
    );
    expect(libraryPage).toContain('the Library sub-nav — US-015)');
  });

  it('landing persistence key lives in DesktopApp', () => {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain("const LAST_COMPANY_CACHE_KEY = 'hq-sync.desktop.last-company.v1'");
  });
});
