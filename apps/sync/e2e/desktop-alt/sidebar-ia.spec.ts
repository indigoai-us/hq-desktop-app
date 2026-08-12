import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getDesktopHotkeyRoute,
  getDesktopLandingRoute,
  resolvePendingDesktopRoute,
  fromV4Route,
  LIBRARY_SECTIONS,
  type DesktopRoute,
} from '../../src/desktop-alt/route';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * US-006 — US-007 / US-018 sidebar IA (behavioral route helpers + source contracts).
 *
 * Locks the chat-first shell landing rules:
 *  - ⌘1–⌘4 = Notifications / Meetings / Marketplace / Library; company digits
 *    map connected-first order (US-018: former Inbox hotkey → Notifications).
 *  - Legacy intents resolve (messages → Messages, inbox → Notifications,
 *    home/sync/mission-control → home, library:marketplace → marketplace).
 *  - getDesktopLandingRoute uses last-visited company then first sidebar row.
 *  - Source: ChatSidebar is primary; V4Sidebar / Mission Control / Inbox retired.
 */

const root = process.cwd();

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
  it('⌘1 → notifications, ⌘3 → marketplace', () => {
    const companies = [workspace({})];
    expect(getDesktopHotkeyRoute(hotkey('1'), companies)).toEqual({
      kind: 'notifications',
    });
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

describe('US-006 / US-007 / US-018: sidebar IA — legacy intent resolution (behavioral)', () => {
  it('messages → Messages; notifications + inbox → Notifications', () => {
    expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
    expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'messages' })).toEqual({ kind: 'messages' });
    expect(fromV4Route({ kind: 'notifications' })).toEqual({ kind: 'notifications' });
    expect(fromV4Route({ kind: 'inbox' })).toEqual({ kind: 'notifications' });
  });

  it('home / sync / mission-control → home', () => {
    expect(resolvePendingDesktopRoute('home')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('sync')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'home' });
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'home' });
  });

  it('legacy library:marketplace alias → top-level marketplace', () => {
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

describe('US-006 / US-007 / US-018: sidebar IA — source contracts', () => {
  it('ChatSidebar is primary; legacy V4Sidebar / Inbox / Mission Control are gone', () => {
    expect(existsSync(join(root, 'src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/pages/InboxPage.svelte'))).toBe(false);
    expect(existsSync(join(root, 'src/desktop-alt/pages/MissionControlPage.svelte'))).toBe(
      false,
    );

    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain('<ChatSidebar');
    expect(desktopApp).not.toContain('<V4Sidebar');
    expect(desktopApp).not.toContain('InboxPage');
    expect(desktopApp).not.toContain('MissionControlPage');

    const route = readRepoFile('src/desktop-alt/route.ts');
    expect(route).toContain("'notifications'");
    expect(route).toContain("'messages'");
    expect(route).toContain("'marketplace'");
    expect(route).not.toMatch(/kind:\s*'inbox'/);
    expect(route).not.toMatch(/kind:\s*'mission-control'/);
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
      'Skills / Workers / Installed / Profile tabs plus the routed',
    );
    expect(libraryPage).toContain('Publish-a-pack footer surface (Marketplace is');
    expect(libraryPage).toContain('top-level now — US-007)');
  });

  it('landing persistence key lives in DesktopApp', () => {
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain("const LAST_COMPANY_CACHE_KEY = 'hq-sync.desktop.last-company.v1'");
  });
});
