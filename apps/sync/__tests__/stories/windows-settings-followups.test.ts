import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatHqFolderMeta } from '../../src/desktop-alt/route';

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');

const settings = read('src/desktop-alt/pages/SettingsPage.svelte');
const titleBar = read('src/desktop-alt/v4/V4TitleBar.svelte');
const paths = read('../../crates/hq-desktop-core/src/paths.rs');

describe('Windows settings follow-up regressions', () => {
  it('renders Windows verbatim paths as normal user-facing paths', () => {
    expect(formatHqFolderMeta(String.raw`\\?\C:\Users\person\lr-hq`)).toBe(
      String.raw`C:\Users\person\lr-hq`,
    );
    expect(formatHqFolderMeta(String.raw`\\?\UNC\server\share\HQ`)).toBe(
      String.raw`\\server\share\HQ`,
    );
  });

  it('keeps action groups and platform chips horizontal', () => {
    expect(settings).toContain('.setting-row > span:first-child');
    expect(settings).toContain('.setting-row > div:first-child');
    expect(settings).not.toMatch(/\.setting-row span,\s*\n\s*\.setting-row div/);
    expect(settings).toMatch(/\.row-actions\s*\{[\s\S]*?display:\s*flex/);
    expect(settings).toMatch(/\.platforms\s*\{[\s\S]*?display:\s*flex/);
  });

  it('themes native select option surfaces for the Windows dark UI', () => {
    expect(settings).toMatch(/select\s*\{[\s\S]*?color-scheme:\s*dark/);
    expect(settings).toMatch(/select option\s*\{[\s\S]*?background:/);
    expect(settings).toMatch(/select option\s*\{[\s\S]*?color:/);
  });

  it('centers recovery action content inside the fixed-height title bar', () => {
    expect(titleBar).toMatch(
      /\.v4-recovery-actions :global\(button\)\s*\{[\s\S]*?box-sizing:\s*border-box/,
    );
    expect(titleBar).toMatch(
      /\.v4-recovery-actions :global\(button\)\s*\{[\s\S]*?justify-content:\s*center/,
    );
    expect(titleBar).toMatch(
      /\.v4-recovery-actions :global\(button\)\s*\{[\s\S]*?padding-block:\s*0/,
    );
  });

  it('uses platform-neutral visible Settings copy', () => {
    for (const macOnlyCopy of [
      'macOS is allowing notifications from HQ',
      'Blocked in macOS',
      'Open HQ when macOS starts.',
      'Checking macOS privacy grants',
      'macOS permissions need attention',
    ]) {
      expect(settings).not.toContain(macOnlyCopy);
    }
  });
});

describe('Windows Node-backed launcher audit', () => {
  it('provides both blocking and Tokio-safe shell-shim constructors', () => {
    expect(paths).toContain('pub fn spawn_command(');
    expect(paths).toContain('pub fn tokio_spawn_command(');
    expect(paths).toContain('std::process::Command::new(path)');
    expect(paths).toContain('tokio::process::Command::new(path)');
  });

  it('routes remaining npm, npx, and hq command sites through shared launchers', () => {
    const sources = [
      read('src-tauri/src/commands/conflicts.rs'),
      read('src-tauri/src/commands/feedback.rs'),
      read('src-tauri/src/commands/hq_cli_update.rs'),
      read('src-tauri/src/commands/hq_core_staging.rs'),
      read('src-tauri/src/commands/marketplace.rs'),
      read('src-tauri/src/commands/packages.rs'),
      read('src-tauri/src/commands/status.rs'),
      read('../../crates/hq-desktop-core/src/hq_cli_update.rs'),
      read('../../crates/hq-desktop-core/src/hq_resolver.rs'),
    ].join('\n');

    expect(sources).not.toMatch(/(?:tokio::process::)?Command::new\(&(?:hq|npm|npx)\)/);
    expect(sources).not.toContain('tokio::process::Command::new("npx")');
    expect(sources).toContain('paths::spawn_command(');
    expect(sources).toContain('paths::tokio_spawn_command(');
  });

  it('confirms the application updater is native and has no Node dependency', () => {
    const updater = read('src-tauri/src/updater.rs');
    const versionGate = read('src-tauri/src/commands/version_gate.rs');
    expect(updater).toContain('download_and_install');
    expect(versionGate).toContain('download_and_install');
    expect(`${updater}\n${versionGate}`).not.toMatch(/resolve_bin\("(?:node|npm|npx)"\)/);
  });
});
