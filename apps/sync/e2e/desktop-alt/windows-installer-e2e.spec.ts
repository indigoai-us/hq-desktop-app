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
const ciOverlay = JSON.parse(
  readFileSync(appUrl('src-tauri/tauri.windows.ci.conf.json'), 'utf8'),
);

describe('Windows production installer E2E', () => {
  it('builds an unsigned production NSIS package with the release sidecar overlay', () => {
    expect(workflow).toContain('windows-installer-e2e:');
    expect(workflow).toContain('installer E2E (x64 NSIS)');
    expect(workflow).toContain('--bundles nsis');
    expect(workflow).toContain('--config src-tauri/tauri.windows.release.conf.json');
    expect(workflow).toContain('--config src-tauri/tauri.windows.ci.conf.json');
    expect(ciOverlay.bundle?.createUpdaterArtifacts).toBe(false);
  });

  it('tests the installed x64 application and always uninstalls it', () => {
    expect(workflow).toContain('-Action install');
    expect(workflow).toContain('HQ_SYNC_DESKTOP_ALT_APP: ${{ steps.install.outputs.app }}');
    expect(workflow).toContain('HQ_SYNC_DESKTOP_ALT_LIVE: "1"');
    expect(workflow).toContain('HQ_INSTALL_DIR: ${{ runner.temp }}\\hq-installer-e2e');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('-Action uninstall');
    expect(installerHarness).toContain('/D=$resolvedInstallDir');
    expect(installerHarness).toContain('-Filter "hq-sync-menubar.exe"');
    expect(installerHarness).toContain('if ($machine -ne 0x8664)');
    expect(installerHarness).toContain('NSIS uninstaller exited with code');
  });
});
