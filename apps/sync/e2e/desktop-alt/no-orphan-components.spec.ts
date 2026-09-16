import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Structural gate. The desktop-alt e2e specs are source-contract checks: they
// read component files as STRINGS and assert on their content, so they "pass"
// whether or not the component is ever mounted. That false-green let PR #232
// ship ~1,560 lines of orphaned, never-rendered V4 components (the dedicated
// safety-flow pages). This spec closes that gap structurally:
//   1. every page/card component under desktop-alt has at least one importer, and
//   2. every DesktopRoute kind has a mount branch in DesktopApp.
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
  // The desktop window mounts HqWorkWorkShell -> the @hq/ui shell, so both
  // trees have to be scanned: importers of a @hq/ui component live in @hq/ui.
  const sources = [
    ...collectSources(join(root, 'src')),
    ...collectSources(join(root, '../../packages/ui/src')),
  ].map((path) => ({
    path,
    body: readFileSync(path, 'utf8'),
  }));

  // Mountable views (pages) + V4 cards/chrome. Each is meant to be imported
  // (rendered) by another component; a zero-importer entry is dead code.
  const mountDirs = [
    '../../packages/ui/src/home',
    '../../packages/ui/src/company',
    '../../packages/ui/src/projects',
    '../../packages/ui/src/library',
    '../../packages/ui/src/marketplace',
    '../../packages/ui/src/meetings',
  ];
  const components = mountDirs.flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((f) => f.endsWith('.svelte'))
      .map((f) => f.replace(/\.svelte$/, '')),
  );

  // Pre-existing orphans, recorded so the gate can bite on NEW ones. These are
  // not approved dead code: each needs deleting or mounting. MarketplacePage
  // was already unreachable on origin/main — the live shell routes Marketplace
  // through LibraryPage — so it is out of scope for the Sessions removal and
  // tracked separately. The list must only ever shrink.
  const KNOWN_ORPHANS = ['MarketplacePage'];

  it('every page/card component has at least one importer', () => {
    // A barrel re-export is NOT an importer. `export { default as X } from
    // './X.svelte'` in an index.ts is exactly the false-green this gate exists
    // to catch: the component compiles, is re-exported, and nothing mounts it.
    // Only a real consumer file counts.
    const orphans = components.filter((name) => {
      const useRe = new RegExp(`\\b${name}\\b`);
      return !sources.some(
        ({ path, body }) =>
          !path.endsWith(`${name}.svelte`) &&
          !/(?:^|\/)index\.ts$/.test(path) &&
          useRe.test(body),
      );
    });
    expect(
      KNOWN_ORPHANS.filter((name) => !orphans.includes(name)),
      'KNOWN_ORPHANS is stale — delete the entries that are no longer orphaned',
    ).toEqual([]);
    expect(orphans.filter((name) => !KNOWN_ORPHANS.includes(name)), `orphaned (never-imported) components: ${orphans.join(', ') || 'none'}`).toEqual([]);
  });

  // The DesktopRoute-kind gate went with route.ts: the live @hq/ui shell is
  // chat-first and has no route union to enumerate, so there is nothing to
  // hold the shell to. The orphan check above is the part that still bites.
});
