/**
 * US-101 — Consume @hq/ui + platform contracts from hq-work-mono.
 *
 * Source-contract on the pin + docs, plus a real resolve of DesktopApp and
 * PlatformAdapter from the installed file: graph. Does not mount DesktopApp.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HQ_WORK_PLATFORM_PACKAGE,
  HQ_WORK_UI_PACKAGE,
} from '../../src/lib/hq-work-ui';
import { ok, unavailable, type PlatformAdapter } from '@hq/platform';

const repoRoot = resolve(process.cwd());
const requireFromSync = createRequire(join(repoRoot, 'package.json'));

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

/**
 * @hq/ui and @hq/core do not list "./package.json" in `exports`, so resolving
 * that subpath throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolve the package entry
 * (".") instead and walk up to the directory that owns its package.json.
 */
function packageDir(name: string): string {
  let dir = dirname(requireFromSync.resolve(name));
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate the package root for ${name}`);
}

describe('US-101 consume @hq/ui + platform contracts', () => {
  const pkg = JSON.parse(readRepo('package.json')) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};

  /**
   * Was: `file:` pins onto a sibling hq-work-mono worktree. That made a bare
   * checkout uninstallable — frontend CI died in seconds on
   * `ENOENT ... /hq-work-mono/.../packages/core`. The packages are now vendored
   * into this repo as workspace members, so `pnpm install` needs no external
   * checkout and no registry.
   */
  it('consumes @hq/ui, @hq/platform, and @hq/core as workspace members', () => {
    expect(deps['@hq/ui']).toBe('workspace:*');
    expect(deps['@hq/platform']).toBe('workspace:*');
    expect(deps['@hq/core']).toBe('workspace:*');
    expect(HQ_WORK_UI_PACKAGE).toBe('@hq/ui');
    expect(HQ_WORK_PLATFORM_PACKAGE).toBe('@hq/platform');

    const workspace = readFileSync(
      resolve(repoRoot, '..', '..', 'pnpm-workspace.yaml'),
      'utf8',
    );
    expect(workspace).toMatch(/^\s*-\s*["']?packages\/\*["']?\s*$/m);
  });

  it('installs with no sibling checkout and no registry', () => {
    // The whole point of vendoring: nothing outside this repo is required.
    for (const pkg of ['core', 'platform', 'ui']) {
      const manifest = JSON.parse(
        readFileSync(resolve(repoRoot, '..', '..', 'packages', pkg, 'package.json'), 'utf8'),
      ) as { name: string; dependencies?: Record<string, string> };
      expect(manifest.name).toBe(`@hq/${pkg}`);
      for (const range of Object.values(manifest.dependencies ?? {})) {
        expect(range).not.toMatch(/^file:/);
        expect(range).not.toMatch(/npm:@indigoai-us/);
      }
    }
    // The pnpmfile existed only to rewrite workspace:* onto sibling file:
    // paths. A real workspace resolves those natively.
    expect(existsSync(resolve(repoRoot, '..', '..', '.pnpmfile.cjs'))).toBe(false);
  });

  it('documents the consume mechanism and how to re-sync the copies', () => {
    const docPath = resolve(repoRoot, 'docs/hq-work-ui-consume.md');
    expect(existsSync(docPath)).toBe(true);
    const doc = readRepo('docs/hq-work-ui-consume.md');
    expect(doc).toContain('workspace:*');
    expect(doc).toContain('packages/VENDORED.md');
    expect(doc).toContain('check-ui-purity.mjs');
    expect(doc).toContain('US-103');
    expect(doc).toContain('US-102');

    // Provenance has to name a specific upstream commit, or "re-copy from
    // mono" is not an actionable instruction.
    const vendored = readFileSync(
      resolve(repoRoot, '..', '..', 'packages', 'VENDORED.md'),
      'utf8',
    );
    expect(vendored).toContain('hq-work-mono');
    expect(vendored).toMatch(/\b[0-9a-f]{40}\b/);

    // Vitest will not strip TypeScript under node_modules, and these packages
    // ship source with no build step.
    expect(readRepo('vite.config.ts')).toContain(
      'inline: [/@hq\\/(ui|platform|core|work)($|\\/)/]',
    );
  });

  it('resolves DesktopApp from @hq/ui and PlatformAdapter from @hq/platform', () => {
    const uiIndex = readFileSync(
      join(packageDir('@hq/ui'), 'src/index.ts'),
      'utf8',
    );
    expect(uiIndex).toContain(
      'export { default as DesktopApp } from "./shell/DesktopApp.svelte"',
    );

    const platformAdapter = readFileSync(
      join(packageDir('@hq/platform'), 'src/adapter.ts'),
      'utf8',
    );
    expect(platformAdapter).toContain('export interface PlatformAdapter');

    expect(existsSync(join(packageDir('@hq/core'), 'src/index.ts'))).toBe(true);

    expect(ok({ n: 1 })).toEqual({ ok: true, value: { n: 1 } });
    expect(unavailable('desktop-only').reason).toBe('unavailable');
    const kind: PlatformAdapter['kind'] = 'desktop';
    expect(kind).toBe('desktop');
  });
});
