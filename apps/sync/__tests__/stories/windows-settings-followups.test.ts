import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
const paths = read('../../crates/hq-desktop-core/src/paths.rs');

describe('Windows settings follow-up regressions', () => {
  it('canonicalizes the HQ folder then strips \\\\?\\ only when legacy Win32 is safe', () => {
    const installDirectory = read('src-tauri/src/commands/install_directory.rs');
    const production = installDirectory.split('#[cfg(test)]')[0] ?? '';
    expect(production).toContain('std::fs::canonicalize(&hq_path)');
    expect(production).toContain('strip_windows_verbatim_prefix');
    expect(production).not.toContain('dunce::canonicalize');
    expect(production).not.toContain('dunce::simplified');
    expect(production).not.toContain('hq_path.canonicalize');
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
    expect(versionGate).toContain('crate::updater::install_stable_update(app).await');
    expect(versionGate).not.toContain('download_and_install');
    expect(`${updater}\n${versionGate}`).not.toMatch(/resolve_bin\("(?:node|npm|npx)"\)/);
  });
});
