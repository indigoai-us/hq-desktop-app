/**
 * US-004 — Sync: silent co-install of HQ Work during Sync auto-update.
 *
 * Source-contract only. Do not live-download. The canonical hook is next
 * launch (`maybe_co_install_hq_work`) because macOS `download_and_install`
 * typically kills the process before the Ok(()) after it.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd());

function readRepo(...parts: string[]): string {
  return readFileSync(resolve(repoRoot, ...parts), 'utf8');
}

describe('US-004 silent HQ Work co-install after Sync update', () => {
  const hq = readRepo('src-tauri/src/commands/hq_work.rs');
  const main = readRepo('src-tauri/src/main.rs');
  const updater = readRepo('src-tauri/src/updater.rs');

  it('exports maybe_co_install_decision and skip/run reasons', () => {
    expect(hq).toContain('pub fn maybe_co_install_decision');
    expect(hq).toContain('CoInstallAction');
    expect(hq).toContain('Skip(CoInstallSkipReason::FlagOff)');
    expect(hq).toContain('Skip(CoInstallSkipReason::AlreadyInstalled)');
    expect(hq).toContain('Skip(CoInstallSkipReason::Uninstalled)');
    expect(hq).toContain('Skip(CoInstallSkipReason::AlreadyAttemptedThisVersion)');
    expect(hq).toContain('hqWorkUninstalled');
    expect(hq).toContain('hqWorkCoInstalledForVersion');
    expect(hq).toContain('hqWorkLastSeenInstalled');
  });

  it('reuses US-003 install_hq_work_with / verify_hq_work_bytes before install', () => {
    const idx = hq.indexOf('fn co_install_from_release_feed');
    expect(idx).toBeGreaterThan(-1);
    const body = hq.slice(idx, idx + 500);
    expect(body).toContain('install_hq_work_with');
    expect(body).toContain('http_get_text');
    expect(body).toContain('http_get_bytes');
    expect(body).toContain('install_verified_bytes');
    expect(hq).toContain('verify_hq_work_bytes');
    expect(hq).toContain('HQ_WORK_FEED_URL');
  });

  it('retries three times with 1s/2s/4s backoff and logs handoff events', () => {
    expect(hq).toContain('CO_INSTALL_ATTEMPT_COUNT: usize = 3');
    expect(hq).toContain('co_install_backoff_delay');
    expect(hq).toContain('1u64 << attempt_index.min(2)');
    expect(hq).toContain('log("handoff", msg)');
    expect(hq).toContain('co_install skipped:');
    expect(hq).toContain('co_install ok');
    expect(hq).toContain('co_install failed:');
  });

  it('never steals focus from the co-install path', () => {
    const start = hq.indexOf('// ── US-004 silent co-install');
    expect(start).toBeGreaterThan(-1);
    const end = hq.indexOf('#[cfg(test)]', start);
    const impl = hq.slice(start, end);
    expect(impl).not.toContain('show_desktop_window');
    expect(impl).not.toContain('show_popover_window');
    expect(impl).not.toContain('reveal_handoff_card');
    expect(impl).not.toContain('open_desktop_alt_window');
    expect(impl).not.toContain('MessageDialog');
    expect(impl).not.toContain('ask_dialog');
  });

  it('main.rs setup spawns maybe_co_install on launch', () => {
    expect(main).toContain('spawn_maybe_co_install_hq_work');
    expect(main).toContain('maybe_co_install');
    const setupAt = main.indexOf('.setup(|app| {');
    const spawnAt = main.indexOf('commands::hq_work::spawn_maybe_co_install_hq_work()');
    expect(setupAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(setupAt);
    expect(main).toContain('tauri::async_runtime::spawn');
  });

  it('updater.rs keeps HQ Work co-install outside the Windows update critical section', () => {
    expect(updater).toContain('spawn_maybe_co_install_hq_work');
    expect(updater).toContain('maybe_co_install');

    const installFnAt = updater.indexOf('async fn install_verified_update(');
    const stableFnAt = updater.indexOf('pub(crate) async fn install_stable_update(');
    const installFn = updater.slice(installFnAt, stableFnAt);
    expect(installFnAt).toBeGreaterThan(-1);
    expect(stableFnAt).toBeGreaterThan(installFnAt);
    expect(installFn).toContain('#[cfg(target_os = "windows")]');
    expect(installFn).toContain('crate::windows_update::install_verified_update(app, update).await');
    expect(installFn).toContain('#[cfg(not(target_os = "windows"))]');
    const downloadAt = installFn.indexOf('download_and_install');
    const postInstallSpawnAt = installFn.indexOf('spawn_maybe_co_install_hq_work');
    expect(downloadAt).toBeGreaterThan(-1);
    expect(postInstallSpawnAt).toBeGreaterThan(downloadAt);
    expect(installFn.indexOf('app.restart()')).toBeGreaterThan(postInstallSpawnAt);

    const autoIdx = updater.indexOf('BackgroundUpdateAction::Install =>');
    expect(autoIdx).toBeGreaterThan(-1);
    const auto = updater.slice(autoIdx, autoIdx + 4500);
    expect(auto).toContain('stage_plugin_update');
    expect(auto).toContain('spawn_auto_install_waiter');
    expect(auto).not.toContain('install_verified_update(&handle, &update)');

    const stagedFnAt = updater.indexOf('async fn install_staged_update(');
    expect(stagedFnAt).toBeGreaterThan(-1);
    const stagedFn = updater.slice(stagedFnAt, stagedFnAt + 2500);
    expect(stagedFn).toContain('#[cfg(not(target_os = "windows"))]');
    const stagedSpawn = stagedFn.indexOf('spawn_maybe_co_install_hq_work');
    expect(stagedSpawn).toBeGreaterThan(-1);
    expect(stagedFn.indexOf('app.restart()')).toBeGreaterThan(stagedSpawn);
  });
});
