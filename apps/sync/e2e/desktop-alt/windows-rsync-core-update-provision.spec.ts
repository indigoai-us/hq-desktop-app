import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

const coreUpdate = readRepoFile('src-tauri/src/commands/hq_core_update.rs');
const installDeps = readRepoFile('src-tauri/src/commands/install_deps.rs');

describe('Windows Core-update rsync provisioning', () => {
  it('checks a real rsync.exe on child_path and probes it before rescue spawn', () => {
    const executableLookup =
      'std::env::split_paths(&hq_desktop_core::paths::child_path())\n' +
      '        .map(|dir| dir.join("rsync.exe"))\n' +
      '        .find(|candidate| candidate.is_file())';
    const versionProbe =
      'CORE_UPDATE_RSYNC_VERSION_TIMEOUT,\n' +
      '        tokio::task::spawn_blocking(move || ensure_rsync_version(&executable))';
    const versionCommand = 'Command::new(rsync_exe)\n        .arg("--version")';
    const preflight =
      '#[cfg(windows)]\n    if let Err(reason) = ensure_managed_rsync_for_core_update_rescue().await {';
    const rescueSpawn = 'let initial_exit_code = spawn_rescue_attempt(';

    expect(installDeps).toContain(executableLookup);
    expect(installDeps).toContain(
      '#[cfg(windows)]\npub(crate) async fn ensure_rsync_for_core_update_rescue()',
    );
    expect(installDeps).toContain(versionProbe);
    expect(installDeps).toContain(versionCommand);
    expect(installDeps).toContain('CORE_UPDATE_RSYNC_VERSION_TIMEOUT: Duration = Duration::from_secs(10);');
    expect(coreUpdate).toContain(preflight);
    expect(coreUpdate.indexOf(preflight)).toBeLessThan(
      coreUpdate.indexOf(rescueSpawn),
    );
  });

  it('forces the bundle install with the 120 second provisioning deadline', () => {
    expect(installDeps).toContain(
      'pub(crate) const CORE_UPDATE_RSYNC_PROVISION_TIMEOUT: Duration = Duration::from_secs(120);',
    );
    expect(installDeps).toContain(
      'install_rsync_with_progress_inner(&mut progress, true)\n        .await',
    );
    expect(installDeps).toContain(
      'if !force_bundle_install && probe.installed && !managed_rsync.exists() {',
    );
    expect(installDeps).toContain(
      'tokio::time::timeout(\n        CORE_UPDATE_RSYNC_PROVISION_TIMEOUT,',
    );
  });

  it('returns a rescue_spawn diagnostic without spawning when provisioning fails', () => {
    const diagnostic =
      'let diagnostic = rsync_missing_rescue_diagnostic(&reason);';
    const failureReturn = 'return Ok(CoreUpdateRescueRun {\n            result:';
    const rescueSpawn = 'let initial_exit_code = spawn_rescue_attempt(';

    expect(coreUpdate).toContain(
      'HQ_RESCUE_FAILURE_KIND=rsync-missing',
    );
    expect(coreUpdate).toContain('rescue_error_kind: Some("rescue_spawn"),');
    expect(coreUpdate).toContain(diagnostic);
    expect(coreUpdate).toContain(failureReturn);
    expect(coreUpdate.indexOf(diagnostic)).toBeLessThan(
      coreUpdate.indexOf(rescueSpawn),
    );
    expect(coreUpdate.indexOf(failureReturn)).toBeLessThan(
      coreUpdate.indexOf(rescueSpawn),
    );
  });
});
