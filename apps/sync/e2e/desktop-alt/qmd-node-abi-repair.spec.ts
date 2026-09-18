import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Feedback #2285 — desktop-installed qmd crashes on Node ABI mismatch.
 *
 * qmd --version does not load better-sqlite3, so a binary compiled for
 * NODE_MODULE_VERSION 141 still looks healthy under HQ's managed Node 22
 * (ABI 127). Search then dies with ERR_DLOPEN_FAILED.
 *
 * The app must: detect the mismatch, rebuild qmd against managed Node,
 * and run that repair on launch for machines that already finished setup.
 */
describe('desktop qmd rebuilds when better-sqlite3 ABI does not match Node (feedback 2285)', () => {
  const installDeps = readRepoFile('src-tauri/src/commands/install_deps.rs');
  const coreAbi = readRepoFile('../../crates/hq-desktop-core/src/qmd_abi.rs');
  const mainRs = readRepoFile('src-tauri/src/main.rs');

  it('classifies the reporter ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch', () => {
    expect(coreAbi).toContain('pub fn looks_like_node_abi_mismatch');
    expect(coreAbi).toContain('ERR_DLOPEN_FAILED');
    expect(coreAbi).toContain('NODE_MODULE_VERSION 141');
    expect(coreAbi).toContain('NODE_MODULE_VERSION 127');
    expect(coreAbi).toContain('fn qmd_needs_rebuild');
  });

  it('treats a pinned qmd with a mismatched sqlite addon as unsatisfied', () => {
    expect(installDeps).toContain('if dep.id == "qmd"');
    expect(installDeps).toContain('qmd_native_needs_rebuild');
    expect(installDeps).toContain('remove_managed_qmd_package');
    expect(installDeps).toContain('preferred_npm_binary');
  });

  it('repairs the mismatch on launch without sending the user through setup again', () => {
    expect(installDeps).toContain('pub fn setup_qmd_abi_repair');
    expect(installDeps).toContain('repair_qmd_native_abi_if_needed');
    expect(mainRs).toContain('commands::install_deps::setup_qmd_abi_repair(app.handle())');
  });
});
