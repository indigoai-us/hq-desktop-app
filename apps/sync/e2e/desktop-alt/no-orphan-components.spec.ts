import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolvePendingDesktopRoute,
  type DesktopRoute,
} from '../../src/desktop-alt/route';

// Structural gate. The desktop-alt e2e specs are source-contract checks: they
// read component files as STRINGS and assert on their content, so they "pass"
// whether or not the component is ever mounted. That false-green let PR #232
// ship ~1,560 lines of orphaned, never-rendered V4 components (the dedicated
// safety-flow pages). This spec closes that gap structurally:
//   1. every page/card component under desktop-alt has at least one importer, and
//   2. every DesktopRoute kind has a mount branch in DesktopApp.
//   3. US-018: retired legacy shell files must stay deleted; deep links remap.
// Either failure means a screen/card exists but nothing renders it.
const root = process.cwd();

function collectSources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectSources(full, acc);
    else if (/\.(svelte|ts)$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('desktop-alt component-mount gate', () => {
  const sources = collectSources(join(root, 'src')).map((path) => ({
    path,
    body: readFileSync(path, 'utf8'),
  }));

  // Mountable views (pages) + V4 cards/chrome. Each is meant to be imported
  // (rendered) by another component; a zero-importer entry is dead code.
  const mountDirs = ['src/desktop-alt/pages', 'src/desktop-alt/v4'];
  // Deliberate exceptions, each tied to a story decision. Keep this list SHORT
  // and remove entries as soon as the component is re-mounted or deleted.
  // - LibraryPage: US-017 mounts LibraryOverlay for route.kind === 'library';
  //   LibraryPage is retained as salvage reference (company LibraryBrowser still
  //   ships) but is no longer imported by DesktopApp.
  // US-018 retired V4Sidebar / InboxPage / MissionControlPage entirely — they
  // must not reappear as "intentionally unmounted" exceptions.
  const intentionallyUnmounted = new Set(['LibraryPage']);
  const components = mountDirs.flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => f.replace(/\.svelte$/, ''))
      .filter((name) => !intentionallyUnmounted.has(name)),
  );

  it('every page/card component has at least one importer', () => {
    const orphans = components.filter((name) => {
      const importRe = new RegExp(`import\\s+${name}\\b[^\\n]*from`);
      return !sources.some(
        ({ path, body }) => !path.endsWith(`${name}.svelte`) && importRe.test(body),
      );
    });
    expect(orphans, `orphaned (never-imported) components: ${orphans.join(', ') || 'none'}`).toEqual(
      [],
    );
  });

  it('every DesktopRoute kind is mounted in DesktopApp', () => {
    const app = readFileSync(join(root, 'src/desktop-alt/DesktopApp.svelte'), 'utf8');
    const route = readFileSync(join(root, 'src/desktop-alt/route.ts'), 'utf8');
    // Extract the kinds declared on the DesktopRoute union (`kind: 'home' | ...`
    // and `kind: 'library';` forms).
    const kinds = new Set<string>();
    for (const m of route.matchAll(/kind:\s*((?:'[a-z-]+'\s*\|?\s*)+)/g)) {
      for (const k of m[1].matchAll(/'([a-z-]+)'/g)) kinds.add(k[1]);
    }
    expect(kinds.size, 'expected to parse DesktopRoute kinds from route.ts').toBeGreaterThan(0);
    // Retired kinds must not re-enter the union (US-018).
    expect(kinds.has('inbox')).toBe(false);
    expect(kinds.has('mission-control')).toBe(false);
    const unmounted = [...kinds].filter((k) => !app.includes(`route.kind === '${k}'`));
    expect(unmounted, `route kinds with no mount branch: ${unmounted.join(', ') || 'none'}`).toEqual(
      [],
    );
  });
});

describe('US-018 legacy shell retirement', () => {
  const retiredFiles = [
    'src/desktop-alt/pages/InboxPage.svelte',
    'src/desktop-alt/pages/MissionControlPage.svelte',
    'src/desktop-alt/v4/V4Sidebar.svelte',
    'src/desktop-alt/v4/SidebarSyncMode.svelte',
  ];

  it('deleted legacy shell files no longer exist on disk', () => {
    for (const rel of retiredFiles) {
      expect(existsSync(join(root, rel)), `${rel} should be deleted`).toBe(false);
    }
  });

  it('DesktopApp no longer imports or mounts retired pages', () => {
    const app = readFileSync(join(root, 'src/desktop-alt/DesktopApp.svelte'), 'utf8');
    expect(app).not.toMatch(/InboxPage/);
    expect(app).not.toMatch(/MissionControlPage/);
    expect(app).not.toMatch(/V4Sidebar/);
    expect(app).toContain('ChatSidebar');
    expect(app).toContain('NotificationsView');
  });

  it('legacy deep links remap to live routes (never null)', () => {
    const remaps: Array<[string, DesktopRoute]> = [
      ['inbox', { kind: 'notifications' }],
      ['mission-control', { kind: 'home' }],
      ['sync', { kind: 'home' }],
      ['activity', { kind: 'home' }],
      ['core-drift', { kind: 'home' }],
      ['drift', { kind: 'home' }],
      ['library:marketplace', { kind: 'marketplace' }],
      ['company:indigo:accounts', { kind: 'company', slug: 'indigo', tab: 'overview' }],
      ['company:indigo:tasks', { kind: 'company', slug: 'indigo', tab: 'projects' }],
      ['company:indigo:library', { kind: 'company', slug: 'indigo', tab: 'skills' }],
      ['company:indigo:more', { kind: 'company', slug: 'indigo', tab: 'activity' }],
    ];
    for (const [name, expected] of remaps) {
      expect(resolvePendingDesktopRoute(name), name).toEqual(expected);
    }
  });
});
