import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type PackageManifest = {
  scripts?: Record<string, string>;
};

function readWorkPackageManifest(): PackageManifest {
  return JSON.parse(
    readFileSync(new URL('../../../work/package.json', import.meta.url), 'utf8'),
  ) as PackageManifest;
}

describe('@hq/work installation contract', () => {
  it('generates SvelteKit files before hq-sync builds the shared work shell', () => {
    const workPackage = readWorkPackageManifest();

    expect(
      workPackage.scripts ?? {},
      "hq-sync's Vite build transforms apps/work TypeScript, whose tsconfig extends a gitignored generated file; apps/work prepare must run svelte-kit sync before builds.",
    ).toMatchObject({ prepare: expect.stringContaining('svelte-kit sync') });
  });
});
