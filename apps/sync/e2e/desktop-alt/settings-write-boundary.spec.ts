import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path);
    }
    if (!/\.(?:ts|svelte)$/.test(entry) || /\.(?:test|spec)\.ts$/.test(entry)) {
      return [];
    }
    return [path];
  });
}

describe('settings write boundary', () => {
  it('allows direct save_settings calls only in the serialized mutation owner', () => {
    const srcRoot = join(process.cwd(), 'src');
    const writers = sourceFiles(srcRoot)
      .filter((path) =>
        /\b(?:invoke|operationInvoker)(?:<[^>]*>)?\(\s*['"]save_settings['"]/.test(
          readFileSync(path, 'utf8'),
        ),
      )
      .map((path) => relative(srcRoot, path))
      .sort();

    expect(
      writers,
      `Direct save_settings writers must route through lib/settings-mutations.ts; found: ${writers.join(', ') || 'none'}`,
    ).toEqual(['lib/settings-mutations.ts']);
    expect(readRepoFile('src/lib/settings-mutations.ts')).toContain("'save_settings'");
  });
});
