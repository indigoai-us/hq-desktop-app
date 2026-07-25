import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { commandOnPath, executableCandidates } from './harness';

/**
 * Regression coverage for the Windows live-harness hole.
 *
 * `cargo install tauri-driver` writes `%USERPROFILE%\.cargo\bin\tauri-driver.exe`.
 * The original `commandOnPath` probed only the bare name, so on Windows it
 * always returned false; `resolveLiveConfig` then fell through to the scripted
 * source-contract harness and the "test the installed application" CI job
 * passed in 68ms without ever launching the binary.
 */
describe('commandOnPath', () => {
  const created: string[] = [];
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  function binDirWith(fileName: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'hq-command-on-path-'));
    created.push(dir);
    writeFileSync(join(dir, fileName), '');
    return dir;
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalPathExt === undefined) delete process.env.PATHEXT;
    else process.env.PATHEXT = originalPathExt;

    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds a .exe-suffixed command on win32', () => {
    const dir = binDirWith('tauri-driver.exe');

    setPlatform('win32');
    process.env.PATH = dir;
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

    expect(commandOnPath('tauri-driver')).toBe(true);
  });

  it('still finds a .exe-suffixed command on win32 when PATHEXT is unset', () => {
    const dir = binDirWith('tauri-driver.exe');

    setPlatform('win32');
    process.env.PATH = dir;
    delete process.env.PATHEXT;

    expect(commandOnPath('tauri-driver')).toBe(true);
  });

  it('reports a genuinely absent command as missing on win32', () => {
    const dir = binDirWith('something-else.exe');

    setPlatform('win32');
    process.env.PATH = dir;
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

    expect(commandOnPath('tauri-driver')).toBe(false);
  });

  it('matches only the exact name on posix, ignoring PATHEXT', () => {
    const bare = binDirWith('tauri-driver');
    const suffixed = binDirWith('tauri-driver.exe');

    setPlatform('linux');
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';

    process.env.PATH = bare;
    expect(commandOnPath('tauri-driver')).toBe(true);

    process.env.PATH = suffixed;
    expect(commandOnPath('tauri-driver')).toBe(false);
  });

  it('expands PATHEXT on win32 and leaves posix names untouched', () => {
    // Both spellings of each extension, because PATHEXT is upper-case but the
    // installed binary is lower-case.
    expect(executableCandidates('tauri-driver', 'win32', '.EXE;.CMD')).toEqual([
      'tauri-driver',
      'tauri-driver.EXE',
      'tauri-driver.exe',
      'tauri-driver.CMD',
      'tauri-driver.cmd',
    ]);
    // An explicitly-suffixed command is already a file name.
    expect(executableCandidates('tauri-driver.exe', 'win32', '.EXE;.CMD')).toEqual([
      'tauri-driver.exe',
    ]);
    expect(executableCandidates('tauri-driver', 'linux', '.EXE;.CMD')).toEqual(['tauri-driver']);
  });
});
