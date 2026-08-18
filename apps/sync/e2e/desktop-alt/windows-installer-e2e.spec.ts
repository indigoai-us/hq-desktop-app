import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const appUrl = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repoUrl = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

const workflow = readFileSync(repoUrl('.github/workflows/windows-check.yml'), 'utf8');
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

describe('Windows production installer E2E', () => {
  it('builds MSI and NSIS packages with the CI and MSI version overlays', () => {
    expect(workflow).toContain('windows-installer-e2e:');
    expect(workflow).toContain('installer E2E (x64 MSI + NSIS)');
    expect(workflow).toContain('--bundles msi nsis');
    // tauri.windows.release.conf.json is gone with the Recall SDK sidecar: it
    // carried only the launcher `bundle.externalBin` and a beforeBuildCommand
    // that rebuilt it.
    expect(workflow).not.toContain('tauri.windows.release.conf.json');
    expect(workflow).toContain('--config src-tauri/tauri.windows.ci.conf.json');
    expect(workflow).toContain('--config $env:TAURI_MSI_VERSION_CONFIG');
    expect(workflow).toContain('Verify prerelease MSI package');
    expect(ciOverlay.bundle?.createUpdaterArtifacts).toBe(false);
  });

  it('tests the installed x64 application and always uninstalls it', () => {
    expect(workflow).toContain('-Action install');
    expect(workflow).toContain('HQ_SYNC_DESKTOP_ALT_APP: ${{ steps.install.outputs.app }}');
    expect(workflow).toContain('HQ_SYNC_DESKTOP_ALT_LIVE: "1"');
    expect(workflow).toContain('$installDir = Join-Path $env:RUNNER_TEMP "hq-installer-e2e"');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('-Action uninstall');
    expect(installerHarness).toContain('/D=$resolvedInstallDir');
    expect(installerHarness).toContain('-Filter "hq-sync-menubar.exe"');
    expect(installerHarness).toContain('if ($machine -ne 0x8664)');
    expect(installerHarness).toContain('NSIS uninstaller exited with code');
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
