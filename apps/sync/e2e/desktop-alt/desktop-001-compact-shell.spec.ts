import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COMPANY_PRIMARY_SECTIONS,
  COMPANY_SECTIONS,
  companyPrimarySectionForTab,
  companyTabForPrimarySection,
  fromV4Route,
  getDesktopSecondarySidebar,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import {
  sortV4CompaniesConnectedFirst,
  V4_COMPANY_PRIMARY_ITEMS,
  v4CompanyPrimaryForTab,
} from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import { readRepoFile } from './harness';

/**
 * DESKTOP-001 — Compact native shell source contracts.
 *
 * Locks: chat-first primary sidebar (ChatSidebar), company model still expands
 * primary children when active, no permanent company secondary sidebar, no
 * bottom status bar, titlebar chrome controls, safe drag regions only on padded
 * noninteractive space, light-mode hierarchy.
 * US-018: V4Sidebar / V4_NAV_ITEMS / getV4SidebarModel retired.
 */

const root = process.cwd();

function workspace(overrides: Partial<Workspace> = {}): Workspace {
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
    role: 'owner',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

const DEFAULT_WINDOW_TRANSPARENCY_FACTOR = 0.65;

function firstLiquidGlassAlpha(
  source: string,
  property: string,
  factor = DEFAULT_WINDOW_TRANSPARENCY_FACTOR,
): number {
  const declaration = source.match(new RegExp(`--${property}:\\s*([^;]+);`));
  expect(declaration, `missing --${property}`).not.toBeNull();
  const value = declaration?.[1].trim() ?? '';
  const expression = value.match(
    /^rgb\(\s*\d+\s+\d+\s+\d+\s*\/\s*clamp\(\s*([\d.]+)\s*,\s*calc\(\s*1\s*-\s*var\(--hq-window-transparency-factor(?:\s*,\s*([\d.]+))?\)\s*\*\s*([\d.]+)\s*\)\s*,\s*([\d.]+)\s*\)\s*\)$/i,
  );
  expect(
    expression,
    `${property} must use the window-transparency liquid-glass expression; received: ${value}`,
  ).not.toBeNull();

  const floor = Number(expression?.[1]);
  const fallback = expression?.[2];
  const multiplier = Number(expression?.[3]);
  const ceiling = Number(expression?.[4]);
  if (fallback !== undefined) {
    expect(Number(fallback), `${property} must retain the 0.65 default factor`).toBe(
      DEFAULT_WINDOW_TRANSPARENCY_FACTOR,
    );
  }
  expect(ceiling, `${property} must resolve fully opaque at factor 0`).toBe(1);
  return Math.min(ceiling, Math.max(floor, 1 - factor * multiplier));
}

describe('DESKTOP-001: compact native shell', () => {
  const companies = [
    workspace({}),
    workspace({ slug: 'liverecover', displayName: 'LiveRecover' }),
  ];

  it('primary shell is ChatSidebar; legacy V4 nav model is gone', () => {
    expect(existsSync(join(root, 'src/desktop-alt/v4/V4Sidebar.svelte'))).toBe(false);
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const route = readRepoFile('src/desktop-alt/route.ts');
    expect(app).toContain('<ChatSidebar');
    // Live global destinations still resolve.
    for (const kind of [
      'notifications',
      'messages',
      'meetings',
      'marketplace',
      'library',
      'files',
    ] as const) {
      expect(resolvePendingDesktopRoute(kind)?.kind).toBe(kind === 'library' ? 'library' : kind);
    }
    expect(route).toContain("'notifications'");
    expect(route).toContain("'messages'");
    // Legacy inbox deep link remaps (US-018).
    expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
  });

  it('selected company expands Overview / Goals / Projects / Skills / Workers / Knowledge / Team / More', () => {
    expect(COMPANY_PRIMARY_SECTIONS.map((s) => s.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'more',
    ]);
    expect(V4_COMPANY_PRIMARY_ITEMS.map((s) => s.id)).toEqual(
      COMPANY_PRIMARY_SECTIONS.map((s) => s.id),
    );

    const rows = sortV4CompaniesConnectedFirst(companies, 'indigo', 'overview');
    const active = rows.find((row) => row.slug === 'indigo');
    expect(active?.expanded).toBe(true);
    expect(active?.children.map((c) => c.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'more',
    ]);
    expect(active?.children.find((c) => c.id === 'overview')?.active).toBe(true);

    const other = rows.find((row) => row.slug === 'liverecover');
    expect(other?.expanded).toBe(false);
    expect(other?.children).toEqual([]);
  });

  it('collapses company children when no company is selected (global destinations)', () => {
    // Without an activeSlug every row stays collapsed — same contract as
    // navigating to notifications / messages / meetings / etc.
    const rows = sortV4CompaniesConnectedFirst(companies);
    expect(rows.every((row) => !row.expanded)).toBe(true);
    expect(rows.every((row) => row.children.length === 0)).toBe(true);
  });

  it('operational tabs light More while Skills and Workers light visible primary children', () => {
    expect(v4CompanyPrimaryForTab('deployments')).toBe('more');
    expect(v4CompanyPrimaryForTab('secrets')).toBe('more');
    expect(v4CompanyPrimaryForTab('settings')).toBe('more');
    expect(v4CompanyPrimaryForTab('skills')).toBe('skills');
    expect(v4CompanyPrimaryForTab('workers')).toBe('workers');
    expect(companyPrimarySectionForTab('secrets')).toBe('more');
    expect(companyPrimarySectionForTab('settings')).toBe('more');
    expect(companyPrimarySectionForTab('skills')).toBe('skills');
    expect(companyPrimarySectionForTab('workers')).toBe('workers');
    expect(companyTabForPrimarySection('more')).toBe('deployments');

    const rows = sortV4CompaniesConnectedFirst(companies, 'indigo', 'more');
    expect(
      rows.find((r) => r.slug === 'indigo')?.children.find((c) => c.id === 'more')?.active,
    ).toBe(true);

    // Full operational + skills/workers routes resolve.
    for (const tab of [
      'skills',
      'workers',
      'deployments',
      'secrets',
      'settings',
    ] as const) {
      expect(resolvePendingDesktopRoute(`company:indigo:${tab}`)).toEqual({
        kind: 'company',
        slug: 'indigo',
        tab,
      });
      expect(COMPANY_SECTIONS.some((s) => s.id === tab)).toBe(true);
    }
    expect(fromV4Route({ kind: 'company', slug: 'indigo', tab: 'more' })).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'deployments',
    });
    // US-020: the Activity page is gone — its deep link lands on Overview.
    expect(resolvePendingDesktopRoute('company:indigo:activity')).toEqual({
      kind: 'company',
      slug: 'indigo',
      tab: 'overview',
    });
  });

  it('never mounts a permanent company secondary sidebar', () => {
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'indigo' }, companies)).toBeNull();
    // US-017: library is a full-screen overlay — no permanent secondary column.
    expect(getDesktopSecondarySidebar({ kind: 'library' }, companies)).toBeNull();
    // US-020: settings is single-pane — no secondary sidebar anywhere.
    expect(getDesktopSecondarySidebar({ kind: 'settings' }, companies)).toBeNull();
  });

  it('DesktopApp composes compact shell: titlebar controls, no status bar, no company secondary', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    const css = readRepoFile('src/desktop-alt/styles/desktop-alt.css');

    expect(app).toContain('<V4TitleBar');
    expect(app).toContain('ontogglesidebar={handleToggleSidebar}');
    expect(app).toContain('oncommand={handleOpenCommandPalette}');
    expect(app).toContain('onaccount={handleAccountMenu}');
    expect(app).toContain("handleOpenSettings('general')");
    expect(app).toContain('accountInitials={accountIdentity.initials}');
    expect(app).toContain('accountLabel={accountIdentity.label}');
    expect(app).toContain('let sidebarCollapsed = $state(false)');
    expect(app).toContain('class:sidebar-collapsed={sidebarCollapsed}');
    // US-003 / US-018: chat-first primary sidebar.
    expect(app).toContain('<ChatSidebar');
    expect(app).not.toContain('<V4Sidebar');
    expect(app).not.toContain('<DesktopStatusBar');
    expect(app).not.toContain("import DesktopStatusBar");
    // US-020: no secondary sidebar mounts at all.
    expect(app).not.toContain('secondarySidebar');
    expect(app).not.toContain('V4SecondarySidebar');

    expect(css).toContain('/* DESKTOP-001: titlebar + body only — bottom status bar grid row removed. */');
    // Shell grid is titlebar + body only (no status-bar row).
    expect(css).toMatch(
      /\.desktop-shell\s*\{[\s\S]*?grid-template-rows:\s*var\(--desktop-titlebar-height[^)]*\)\s+minmax\(0,\s*1fr\);/,
    );
  });

  it('titlebar is minimal (wordmark, day, meetings, bell, Core); drag only on pads', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');

    expect(titleBar).toMatch(/Show sidebar|Hide sidebar/);
    expect(titleBar).toContain('data-testid="titlebar-wordmark"');
    expect(titleBar).toContain('data-testid="titlebar-day-date"');
    expect(titleBar).toContain('data-testid="titlebar-meetings"');
    expect(titleBar).toContain('data-testid="titlebar-notifications"');
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    // Drag region is on padded spacers only — not the whole header.
    expect(titleBar).not.toMatch(/<header class="v4-titlebar" data-tauri-drag-region/);
    expect(titleBar).toContain('data-tauri-drag-region');
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-lights"');
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-flex"');
    // V1 chrome removed (D-04).
    expect(titleBar).not.toContain('class="v4-status"');
    expect(titleBar).not.toContain('class="v4-action"');
  });

  it('company primary children remain modeled for expansion (sortV4CompaniesConnectedFirst)', () => {
    const model = readRepoFile('src/desktop-alt/v4/model.ts');
    expect(model).toContain('export function sortV4CompaniesConnectedFirst');
    expect(model).toContain('V4_COMPANY_PRIMARY_ITEMS');
    expect(model).toContain('expanded: active && workspace.membershipStatus !==');
    expect(model).toContain("child");
  });

  it('light-mode material roles stay visibly translucent with weighted hierarchy', () => {
    const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
    const properties = ['v4-ground', 'v4-chrome', 'v4-sidebar', 'v4-raised'] as const;
    const [ground, chrome, sidebar, raised] = properties.map((property) =>
      firstLiquidGlassAlpha(tokens, property),
    );

    expect(ground).toBeLessThanOrEqual(0.5);
    expect(chrome).toBeLessThanOrEqual(0.5);
    expect(sidebar).toBeLessThanOrEqual(0.5);
    expect(raised).toBeGreaterThan(ground);
    expect(raised).toBeLessThanOrEqual(0.6);
    for (const property of properties) {
      expect(firstLiquidGlassAlpha(tokens, property, 0)).toBe(1);
    }
    expect(tokens).toContain('DESKTOP-012');
  });
});
