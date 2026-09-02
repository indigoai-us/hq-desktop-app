import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appUrl = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repoUrl = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

const workflow = readFileSync(repoUrl('.github/workflows/windows-check.yml'), 'utf8');
const liveDriver = readFileSync(appUrl('e2e/desktop-alt/live-driver.ts'), 'utf8');
const livePreauth = readFileSync(appUrl('e2e/desktop-alt/live-preauth.spec.ts'), 'utf8');
const installerHarness = readFileSync(
  appUrl('scripts/windows-installer-e2e.ps1'),
  'utf8',
);
const dependencyInstaller = readFileSync(
  appUrl('src-tauri/src/commands/install_deps.rs'),
  'utf8',
);
const ciOverlay = JSON.parse(
  readFileSync(appUrl('src-tauri/tauri.windows.ci.conf.json'), 'utf8'),
);
const windowsConf = JSON.parse(
  readFileSync(appUrl('src-tauri/tauri.windows.conf.json'), 'utf8'),
);
const installerHooks = readFileSync(
  appUrl('src-tauri/windows/installer-hooks.nsh'),
  'utf8',
);
const updater = readFileSync(appUrl('src-tauri/src/updater.rs'), 'utf8');
const windowsUpdate = readFileSync(
  appUrl('src-tauri/src/windows_update.rs'),
  'utf8',
);
const processRegistry = readFileSync(
  appUrl('src-tauri/src/commands/process.rs'),
  'utf8',
);
const versionGate = readFileSync(
  appUrl('src-tauri/src/commands/version_gate.rs'),
  'utf8',
);
const main = readFileSync(appUrl('src-tauri/src/main.rs'), 'utf8');

describe('Windows production installer E2E', () => {
  it('builds MSI and NSIS packages with the release and MSI version overlays', () => {
    expect(workflow).toContain('windows-installer-e2e:');
    expect(workflow).toContain('installer E2E (x64 MSI + NSIS)');
    expect(workflow).toContain('--bundles msi nsis');
    expect(workflow).toContain('--config src-tauri/tauri.windows.release.conf.json');
    expect(workflow).toContain('--config src-tauri/tauri.windows.ci.conf.json');
    expect(workflow).toContain('--config $env:TAURI_MSI_VERSION_CONFIG');
    expect(workflow).toContain('Verify prerelease MSI package');
    expect(ciOverlay.bundle?.createUpdaterArtifacts).toBe(false);
  });

  it('tests the upgraded x64 application and always uninstalls it', () => {
    expect(workflow).toContain('-Action install');
    expect(workflow).toContain('Install PR bridge NSIS package');
    expect(workflow).toContain('bundle\\nsis');
    expect(workflow).toContain('-Action upgrade');
    expect(workflow).toContain(
      'HQ_SYNC_DESKTOP_ALT_APP: ${{ steps.upgrade.outputs.app }}',
    );
    expect(workflow).toContain('HQ_SYNC_DESKTOP_ALT_LIVE: "1"');
    expect(workflow).toContain('$installDir = Join-Path $env:RUNNER_TEMP "hq-installer-e2e"');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('-Action uninstall');
    expect(installerHarness).toContain('/D=$resolvedInstallDir');
    expect(installerHarness).toContain('-Filter "hq-sync-menubar.exe"');
    expect(installerHarness).toContain('if ($machine -ne 0x8664)');
    expect(installerHarness).toContain('NSIS uninstaller exited with code');
  });

  it('upgrades a running PR build only after its same-version helper observes parent exit', () => {
    expect(workflow).toContain('Prepare bridge and target versions');
    expect(workflow).toContain('Install PR bridge NSIS package');
    expect(workflow).toContain(
      'Roll back NSIS-installed bridge after an installer failure',
    );
    expect(workflow).toContain('Build next synthetic NSIS updater');
    expect(workflow).toContain(
      'Upgrade running PR bridge through its copied helper',
    );
    const updaterStep = workflow.slice(
      workflow.indexOf('The synthetic updater used to be a second full'),
      workflow.indexOf('Upgrade running PR bridge through its copied helper'),
    );
    expect(updaterStep).toContain('pnpm tauri bundle');
    expect(updaterStep).not.toContain('pnpm tauri build');
    expect(updaterStep).toContain('windows-pe-version.mjs');
    expect(updaterStep).toContain('same compiled binary');
    expect(installerHarness).toContain('--hq-update-helper');
    expect(installerHarness).toContain(
      'Installer modified the application before the parent exited',
    );
    expect(installerHarness).toContain(
      'Update helper exited while the prior-version parent was still running',
    );
    expect(installerHarness).toContain(
      'Upgrade left the prior-version binary in place',
    );
    expect(installerHarness).toContain('.VersionInfo.ProductVersion');
    expect(installerHarness).toContain(
      "does not match target '$TargetVersion'",
    );
    expect(installerHarness).toContain('$receipt.state -ne "installed"');
    expect(workflow).toContain(
      'Roll back NSIS-installed target after an installer failure',
    );
    expect(workflow).toContain('-Action rollback');
    expect(installerHarness).toContain('$receipt.state -ne "rolled-back"');
    expect(installerHarness).toContain(
      'Staged helper is not the installed parent binary',
    );
    expect(installerHarness).toContain(
      'Copy-Item -LiteralPath $installedApp -Destination $stagedHelper',
    );
    expect(installerHarness).not.toContain('$HelperPath');
    expect(installerHarness).toContain(
      'Copy-InstallTree -Source $resolvedInstallDir -Destination $installBackup',
    );
    expect(installerHarness).toContain(
      'Dictionary[string,string]',
    );
    expect(installerHarness).toContain(
      '$serializableManifest.GetType()',
    );
    expect(installerHarness).toContain(
      '[System.Text.Json.JsonSerializerOptions]::new()',
    );
    expect(installerHarness).toContain(
      'Snapshot-UninstallRegistry -Path $registryBackup',
    );
    expect(installerHarness).toContain(
      '"--prior-nsis-registry", $registryState',
    );
    expect(installerHarness).toContain(
      'Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force',
    );
    expect(installerHarness).toContain(
      'Rollback did not restore the complete prior installation',
    );
    expect(installerHarness).toContain(
      'Rollback did not restore the exact prior uninstall registry metadata',
    );
    expect(installerHarness).toContain(
      'Rollback left candidate-only registry metadata behind',
    );
    expect(windowsUpdate).toContain(
      'automatic update cannot safely migrate an MSI-installed HQ',
    );
    expect(installerHarness).toContain('$global:LASTEXITCODE = 0');
    expect(installerHarness).toContain('-RedirectStandardError $helperStderr');
    expect(installerHarness).toContain(
      'Rollback helper exited before readiness:',
    );
    expect(installerHarness).toContain(
      'Update rollback changed existing HQ shortcuts',
    );
  });

  it('routes every Windows update trigger through the guarded helper handoff', () => {
    expect(updater).toContain(
      'crate::windows_update::install_verified_update(app, update).await',
    );
    expect(updater).toContain('pub(crate) async fn install_stable_update');
    expect(versionGate).toContain('crate::updater::install_stable_update(app).await');
    expect(versionGate).not.toContain('download_and_install');
    expect(main).toContain('windows_update::run_helper_if_requested()');
    expect(windowsUpdate).toContain('.download(|_, _| {}, || {})');
    expect(windowsUpdate).toContain('quiesce_for_update(PROCESS_EXIT_TIMEOUT)');
    expect(windowsUpdate).toContain('app.exit(0)');
    expect(windowsUpdate).toContain('.args(["/P", "/R", "/UPDATE"])');
    expect(windowsUpdate).toContain('restore_prior_installation(');
    expect(windowsUpdate).toContain('copy_install_tree(&install_dir, &install_backup)');
    expect(windowsUpdate).toContain('snapshot_uninstall_registry(&uninstall_registry_backup)');
    expect(windowsUpdate).toContain('restore_install_tree(');
    expect(windowsUpdate).toContain('restore_uninstall_registry(');
    expect(windowsUpdate).toContain(
      'WIN32_ERROR::from_error(error) == Some(ERROR_INVALID_PARAMETER)',
    );
    expect(windowsUpdate).toContain(
      'open HQ parent process {parent_pid} for synchronization',
    );
    const parentOpen = windowsUpdate.indexOf('let parent = open_parent(parent_pid)?;');
    const readyMarker = windowsUpdate.indexOf('write_new_file(&ready, b"ready")?;');
    expect(parentOpen).toBeGreaterThan(-1);
    expect(readyMarker).toBeGreaterThan(parentOpen);
    expect(windowsUpdate).toContain('cleanup_update_staging_dirs();');
    expect(windowsUpdate).toContain(
      'write_receipt(&receipt, "failed", &version, Some(&error))',
    );
    expect(windowsUpdate).toContain('cleanup_rollback_swap_dirs();');
    expect(windowsUpdate).toContain('FAILED_INSTALL_PREFIX');
    expect(windowsUpdate).toContain('stop_helper_and_cleanup(&mut helper, &staged)');
    expect(updater).toContain('install_failure_is_transient_deferral');
    expect(updater).toContain(
      'automatic update deferred during install startup; retrying soon',
    );
    expect(processRegistry).toContain('UPDATE_QUIESCE_REQUESTED');
    expect(processRegistry).toContain('pub fn quiesce_for_update');
    expect(processRegistry).toContain(
      'fn windows_pid_alive(pid: u32) -> Result<bool, String>',
    );
    expect(processRegistry).toContain(
      'WIN32_ERROR::from_error(error) == Some(ERROR_INVALID_PARAMETER)',
    );
    expect(processRegistry).toContain('open HQ process {pid} for exit query');
    expect(processRegistry).toContain('query HQ process {pid} exit code');
    expect(processRegistry).toContain('require_update_job_containment(&processes)?');
    expect(processRegistry).toContain(
      'cannot safely quiesce an HQ process without Job Object containment',
    );
  });

  it('keeps cargo check and installer E2E independent except for the path gate', () => {
    const checkHeader = workflow.slice(
      workflow.indexOf('\n  windows-check:\n'),
      workflow.indexOf('\n    steps:', workflow.indexOf('\n  windows-check:\n')),
    );
    const installerHeader = workflow.slice(
      workflow.indexOf('\n  windows-installer-e2e:\n'),
      workflow.indexOf('\n    steps:', workflow.indexOf('\n  windows-installer-e2e:\n')),
    );
    expect(checkHeader).toMatch(/^\s+needs: changes$/m);
    expect(installerHeader).toMatch(/^\s+needs: changes$/m);
  });

  it('polls the live quit-path process lookup and retries only that test', () => {
    expect(liveDriver).toContain('LIVE_PROCESS_LOOKUP_TIMEOUT_MS = 10_000');
    expect(liveDriver).toContain('Get-CimInstance Win32_Process');
    expect(livePreauth).toContain("{ retry: 1 }");
    expect(livePreauth).toContain('runs the real quit path and exits the Windows process within its bound');
    expect(workflow).not.toMatch(/vitest run[^\n]*--retry/);
  });

  it('stops HQ processes before install and uninstall so locked files never break setup', () => {
    // 2026-08-02 field failure: NSIS died with "Error opening file for
    // writing" on hq-sync-menubar.exe because HQ processes still ran from the
    // install directory. The hooks must ship in the Windows bundle config and
    // fire on BOTH install and uninstall so a fresh setup self-heals over a
    // corrupted prior install.
    expect(windowsConf.bundle?.windows?.nsis?.installerHooks).toBe(
      './windows/installer-hooks.nsh',
    );
    expect(installerHooks).toContain('NSIS_HOOK_PREINSTALL');
    expect(installerHooks).toContain('NSIS_HOOK_PREUNINSTALL');
    expect(installerHooks).toContain('HQ_STOP_INSTALL_DIR_PROCESSES');
    // No tree kill (/T) on the app: when the in-app updater launches the
    // installer, the installer is a descendant of hq-sync-menubar.exe and a
    // tree kill would terminate the installer itself mid-update.
    expect(installerHooks).toContain('taskkill /F /IM "hq-sync-menubar.exe"');
    expect(installerHooks).not.toContain('/T /IM "hq-sync-menubar.exe"');
    expect(installerHooks).toContain('taskkill /F /T /IM "recall-desktop-sdk.exe"');
    // The generic sweep is path-scoped to the install directory. A blanket
    // image-name kill of node.exe would murder unrelated user processes.
    expect(installerHooks).toContain('-like \\"$INSTDIR\\*\\"');
    expect(installerHooks).not.toMatch(/\/IM\s+"?node\.exe/);
  });

  it('provisions Node from HQ\'s verified per-user toolchain on Windows', () => {
    const installNodeWindows = dependencyInstaller.slice(
      dependencyInstaller.indexOf('async fn install_node_windows'),
      dependencyInstaller.indexOf('fn windows_managed_node_sha256_for'),
    );

    expect(installNodeWindows).toContain('install_managed_node(&app).await');
    expect(installNodeWindows).not.toContain('winget_install');
    expect(installNodeWindows).not.toContain('scoop_install');
  });
});
