import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * HQ-DESKTOP-5E — node-llama-cpp's postinstall must never abort the hq-CLI update
 * or the first-run install.
 *
 * The reopened failure: the ordinary hq-cli install ran under HQ's own managed
 * Node 22 (ABI 127), and node-llama-cpp@3.18.1's `postinstall`
 * (`node ./dist/cli/cli.js postinstall`, pulled in via hq-cli -> @tobilu/qmd)
 * exited 1 there. Under the managed toolchain the updater has no fallback for a
 * lifecycle failure (the managed retry is correctly `not-armed` — there is no
 * other runtime to try), so it aborted the WHOLE hq-cli update. The postinstall
 * is not needed for hq or qmd to work: qmd loads the binary lazily at runtime
 * (`build:auto`) and the prebuilt optional dependency is installed regardless of
 * scripts.
 *
 * The fix injects `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` and
 * `NODE_LLAMA_CPP_POSTINSTALL=skip` into every desktop-spawned npm install that
 * can pull node-llama-cpp, turning that postinstall into a no-op per
 * node-llama-cpp's own OnPostInstallCommand contract. The env lives in ONE shared
 * constant in hq-desktop-core so the updater and the first-run installer cannot
 * drift. This spec locks that source contract; it runs inside the scripted
 * "Desktop-alt E2E" CI job with no built binary.
 */

describe('node-llama-cpp postinstall no longer aborts the hq-CLI install (HQ-DESKTOP-5E)', () => {
  const core = readRepoFile('../../crates/hq-desktop-core/src/hq_cli_update.rs');
  const updater = readRepoFile('src-tauri/src/commands/hq_cli_update.rs');
  const installer = readRepoFile('src-tauri/src/commands/install_deps.rs');

  const occurrences = (haystack: string, needle: string) =>
    haystack.split(needle).length - 1;

  // Slice a Rust fn body from its signature to the next item, so a match cannot be
  // satisfied by unrelated code elsewhere in the file.
  const sliceBetween = (src: string, startMarker: string, endMarker: string) => {
    const start = src.indexOf(startMarker);
    expect(start, `missing ${startMarker}`).toBeGreaterThanOrEqual(0);
    const end = src.indexOf(endMarker, start + startMarker.length);
    expect(end, `missing ${endMarker} after ${startMarker}`).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it('defines the shared child-env constant exactly once, in hq-desktop-core', () => {
    // The single source of truth for both the updater and the first-run installer.
    expect(occurrences(core, 'pub const NPM_INSTALL_CHILD_ENV')).toBe(1);
    const constBlock = sliceBetween(
      core,
      'pub const NPM_INSTALL_CHILD_ENV',
      '];',
    );
    expect(constBlock).toContain('"NODE_LLAMA_CPP_SKIP_DOWNLOAD", "true"');
    expect(constBlock).toContain('"NODE_LLAMA_CPP_POSTINSTALL", "skip"');

    // The app crate must NOT define its own copy — it imports the core one, so the
    // updater and installer can never drift.
    expect(updater).not.toContain('const NPM_INSTALL_CHILD_ENV');
    expect(installer).not.toContain('const NPM_INSTALL_CHILD_ENV');
  });

  it('carries the shared env on the updater npm child (npm_install_command)', () => {
    const body = sliceBetween(updater, 'fn npm_install_command(', 'fn prepare_app_npm_cache(');
    expect(body).toContain('.envs(NPM_INSTALL_CHILD_ENV.iter().copied())');
    // PATH and the app-owned cache are still set — the env is additive, not a swap.
    expect(body).toContain('.env("PATH", path)');
    expect(body).toContain('.env("NPM_CONFIG_CACHE", npm_cache)');
  });

  it('carries the shared env on the pnpm and bun updater executors too', () => {
    // A pnpm- or Bun-managed hq update installs @indigoai-us/hq-cli -> node-llama-cpp
    // and can run its postinstall, so those spawn sites carry the same skip env as
    // the npm one (HQ-DESKTOP-5E).
    const pnpmChild = sliceBetween(updater, 'spawn_command(&pnpm,', '.output()');
    expect(pnpmChild).toContain('NPM_INSTALL_CHILD_ENV');
    const bunChild = sliceBetween(updater, 'spawn_command(&bun,', '.output()');
    expect(bunChild).toContain('NPM_INSTALL_CHILD_ENV');
  });

  it('routes every first-run npm install for qmd/hq-cli through the env seam', () => {
    // The env seam exists and the plain wrapper delegates to it.
    expect(installer).toContain('async fn run_streaming_with_env');
    expect(installer).toContain('run_streaming_with_env(app, program, args, &[]).await');

    // macOS: the managed installer for @tobilu/qmd and @indigoai-us/hq-cli — both
    // rungs (configured registry, then the public-registry retry).
    const managed = sliceBetween(
      installer,
      'async fn npm_install_global_managed(',
      'pub const MANAGED_QMD_VERSION',
    );
    expect(occurrences(managed, 'hq_desktop_core::hq_cli_update::NPM_INSTALL_CHILD_ENV')).toBe(2);
    expect(managed).not.toContain(' run_streaming(');

    // Windows: qmd and hq-cli install sites.
    const qmdWin = sliceBetween(
      installer,
      'async fn install_qmd_windows(',
      'fn write_qmd_bash_shim(',
    );
    expect(qmdWin).toContain('run_streaming_with_env(');
    expect(qmdWin).toContain('hq_desktop_core::hq_cli_update::NPM_INSTALL_CHILD_ENV');

    const hqCliWin = sliceBetween(
      installer,
      'async fn install_hq_cli_windows(',
      'fn patch_hq_cli_pack_install_rsync(',
    );
    expect(hqCliWin).toContain('run_streaming_with_env(');
    expect(hqCliWin).toContain('hq_desktop_core::hq_cli_update::NPM_INSTALL_CHILD_ENV');
  });

  it('does not weaken the npm install: no --ignore-scripts, no --omit=optional', () => {
    // better-sqlite3's install script must still run and the @node-llama-cpp
    // prebuilt optional dependency must still be installed for the lazy runtime
    // load — the fix is env-only, never a change to what npm installs or runs.
    const installArgv = sliceBetween(core, 'pub fn install_argv(', '\n}');
    expect(installArgv).not.toContain('--ignore-scripts');
    expect(installArgv).not.toContain('--omit=optional');

    expect(installer).not.toContain('--ignore-scripts');
    expect(installer).not.toContain('--omit=optional');
    expect(updater).not.toContain('--ignore-scripts');
    expect(updater).not.toContain('--omit=optional');
  });
});
