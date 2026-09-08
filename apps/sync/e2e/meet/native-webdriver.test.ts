import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
describe('packaged native WebDriver isolation', () => {
  it('requires an explicit Cargo feature and preserves production security', () => {
    const cargo = read('../../src-tauri/Cargo.toml');
    expect(cargo).toContain('tauri-plugin-wdio-webdriver = { version = "=1.4.0", optional = true }');
    expect(cargo).toContain('meet-native-webdriver = ["dep:tauri-plugin-wdio-webdriver"]');
    expect(cargo).not.toMatch(/^default\s*=.*meet-native-webdriver/m);
    const main = read('../../src-tauri/src/main.rs');
    expect(main).toContain('#[cfg(feature = "meet-native-webdriver")]\n    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init_with_port(4445));');
    expect(main.indexOf('tauri_plugin_single_instance::init')).toBeLessThan(main.indexOf('init_with_port(4445)'));
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
