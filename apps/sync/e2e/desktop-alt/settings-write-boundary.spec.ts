import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

function hasDirectSaveSettingsWriter(source: string): boolean {
  return /(['"])save_settings\1/.test(source);
}

describe('settings write boundary', () => {
  it('detects the save_settings command independently of the local callee name', () => {
    expect(hasDirectSaveSettingsWriter("invokeFn('save_settings', {})")).toBe(true);
    expect(hasDirectSaveSettingsWriter('tauriInvoke("save_settings", {})')).toBe(true);
  });

  it('does not mistake the VersionPopout save_settings log for a writer', () => {
    expect(
      hasDirectSaveSettingsWriter(
        "console.error('save_settings (autoUpdate) failed:', err)",
      ),
    ).toBe(false);
  });

  it('keeps the direct save_settings call in the shared serialized mutation owner', () => {
    const srcRoot = join(process.cwd(), 'src');
    const writers = sourceFiles(srcRoot)
      .filter((path) =>
        hasDirectSaveSettingsWriter(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(srcRoot, path))
      .sort();

    expect(
      writers,
      `Sync source must delegate save_settings to the shared mutation owner; found: ${writers.join(', ') || 'none'}`,
    ).toEqual([]);
    expect(
      readFileSync(
        resolve(process.cwd(), '../../packages/platform/src/tauri/settings-mutations.ts'),
        'utf8',
      ),
    ).toContain("'save_settings'");
    expect(readRepoFile('src/lib/settings-mutations.ts')).toContain(
      'updateInjectedSettings',
    );
  });
});
