import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('packaged native WebDriver build isolation', () => {
  it('keeps the native driver dependency behind a non-default feature', () => {
    const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', new URL('../../src-tauri/Cargo.toml', import.meta.url).pathname], { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0);
    const pkg = JSON.parse(result.stdout).packages.find((p: { name: string }) => p.name === 'hq-sync-menubar');
    expect(pkg.dependencies.find((d: { name: string }) => d.name === 'tauri-plugin-wdio-webdriver').optional).toBe(true);
    expect(pkg.features['meet-native-webdriver']).toEqual(['dep:tauri-plugin-wdio-webdriver']);
    expect(pkg.features.default ?? []).not.toContain('meet-native-webdriver');
  });
});

// Exercise shell argument boundaries without any real certificate/keychain access.
describe('isolated signing keychain', () => {
  it.skipIf(process.platform === 'win32')('passes the chosen keychain as one argument and leaves the search list alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-sign-test-'));
    try {
      const app = join(dir, 'Test.app');
      mkdirSync(app);
      const keychain = join(dir, 'ephemeral signing.keychain-db');
      writeFileSync(keychain, '');
      const log = join(dir, 'args');
      writeFileSync(join(dir, 'security'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_ARGS"\nexit 1\n', { mode: 0o700 });
      const result = spawnSync('bash', [new URL('../../scripts/sign-bundle.sh', import.meta.url).pathname, app, 'Test Identity'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HQ_SIGN_KEYCHAIN: keychain, TEST_ARGS: log }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['find-identity', '-v', '-p', 'codesigning', keychain]);
      expect(result.stderr).toContain('not found in the selected keychain scope');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
