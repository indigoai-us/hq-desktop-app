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

function packageDir(name: string): string {
  return dirname(requireFromSync.resolve(`${name}/package.json`));
}

describe('US-101 consume @hq/ui + platform contracts', () => {
  const pkg = JSON.parse(readRepo('package.json')) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};

  it('pins @hq/ui, @hq/platform, and @hq/core via file: (whole graph)', () => {
    expect(deps['@hq/ui']).toMatch(/^file:.+\/packages\/ui$/);
    expect(deps['@hq/platform']).toMatch(/^file:.+\/packages\/platform$/);
    expect(deps['@hq/core']).toMatch(/^file:.+\/packages\/core$/);
    expect(HQ_WORK_UI_PACKAGE).toBe('@hq/ui');
    expect(HQ_WORK_PLATFORM_PACKAGE).toBe('@hq/platform');
  });

  it('documents the consume mechanism and exact GitHub Packages pin', () => {
    const docPath = resolve(repoRoot, 'docs/hq-work-ui-consume.md');
    expect(existsSync(docPath)).toBe(true);
    const doc = readRepo('docs/hq-work-ui-consume.md');
    expect(doc).toContain('@indigoai-us/hq-work-ui');
    expect(doc).toContain('https://npm.pkg.github.com');
    expect(doc).toContain('Never');
    expect(doc).toContain('file:');
    expect(doc).toContain('check-ui-purity.mjs');
    expect(doc).toContain('US-103');
    expect(doc).toContain('US-102');
    expect(readRepo('vite.config.ts')).toContain(
      'inline: [/@hq\\/(ui|platform|core)($|\\/)/]',
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
