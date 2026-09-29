import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installDeps = readFileSync(
  resolve(process.cwd(), 'src-tauri/src/commands/install_deps.rs'),
  'utf8',
);

function section(start: string, end: string): string {
  const startAt = installDeps.indexOf(start);
  if (startAt < 0) throw new Error(`missing Rust section: ${start}`);
  const endAt = installDeps.indexOf(end, startAt);
  if (endAt < 0) throw new Error(`missing end marker: ${end}`);
  return installDeps.slice(startAt, endAt);
}

describe('SC-014 managed npm and Node pairing', () => {
  it('does not satisfy setup with a system Node or fall back to system npm', () => {
    const nodeGate = section('fn dep_is_satisfied(', 'fn remove_managed_qmd_package(');
    expect(nodeGate).toContain('managed_node_toolchain_is_usable');

    const toolchainCheck = section(
      'fn managed_node_toolchain_is_usable(',
      '/// Install Node.js into HQ\'s user-local managed toolchain.',
    );
    const npmSelector = section('fn preferred_npm_binary()', '// ─');
    const hqCliInstaller = section('async fn install_hq_cli_macos(', '// NOTE (2026-04-21)');
    const managedPath = section(
      'pub fn extended_search_path_in(',
      '    // Standard macOS install locations',
    );
    const npmRunner = section(
      'async fn run_streaming_with_npm_cache<R:',
      '    command.stdout(',
    );

    expect(toolchainCheck).toContain('join("npm")');
    expect(toolchainCheck).toContain('managed_node_reported_version');
    expect(toolchainCheck).toContain('MANAGED_NODE_VERSION');
    expect(npmSelector).toContain('managed_node_toolchain_is_usable');
    expect(npmSelector).toContain('managed_node_bin_in(&home).join("npm")');
    expect(npmSelector).not.toMatch(/which::which_in\s*\(/);
    expect(hqCliInstaller).toContain('preferred_npm_binary()');
    expect(hqCliInstaller).not.toMatch(/which::which_in\s*\(/);

    const managedNodePathIndex = managedPath.indexOf('for p in managed_tool_paths_in(home)');
    const inheritedPathIndex = managedPath.indexOf('if let Ok(existing) = std::env::var("PATH")');
    expect(managedNodePathIndex).toBeGreaterThanOrEqual(0);
    expect(inheritedPathIndex).toBeGreaterThan(managedNodePathIndex);
    expect(npmRunner).toContain('setup_npm_command(program, &extended_search_path()');
    expect(npmRunner).toContain('command.args(args).env("PATH", extended_search_path())');
  });
});
