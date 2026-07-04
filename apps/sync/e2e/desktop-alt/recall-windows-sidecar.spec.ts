import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-contract regression guard for the Windows Recall SDK sidecar.
 *
 * The Windows bundle needs a real PE launcher in Tauri externalBin. Bundling
 * only bridge.mjs/node_modules silently disables recording because Rust cannot
 * spawn a .cmd shim via CreateProcess. This pins the three required pieces:
 * launcher build scripts, Windows Tauri externalBin wiring, and the release
 * workflow assertion that the launcher exists before Tauri bundles.
 *
 * The externalBin lives in a RELEASE-ONLY overlay (tauri.windows.release.conf.json)
 * rather than the auto-merged tauri.windows.conf.json. Tauri validates externalBin
 * existence during `cargo check`, but the per-target PE launcher is only built at
 * release time — so keeping it out of the auto-merged config is what lets the
 * windows-check.yml `cargo check` pass. The release build merges the overlay via a
 * second `--config`.
 */

const appUrl = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const repoUrl = (rel: string) =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url));

const windowsConf = JSON.parse(
  readFileSync(appUrl('src-tauri/tauri.windows.conf.json'), 'utf8'),
);
const windowsReleaseConf = JSON.parse(
  readFileSync(appUrl('src-tauri/tauri.windows.release.conf.json'), 'utf8'),
);
const sidecarPackage = JSON.parse(
  readFileSync(appUrl('sidecar/recall-sdk-bridge/package.json'), 'utf8'),
);
const releaseWorkflow = readFileSync(repoUrl('.github/workflows/release.yml'), 'utf8');

describe('Windows Recall SDK sidecar bundle parity', () => {
  it('declares the Windows externalBin launcher in the release-only overlay', () => {
    expect(windowsReleaseConf.bundle?.externalBin).toContain('binaries/recall-desktop-sdk');
    expect(windowsReleaseConf.build?.beforeBuildCommand).toContain(
      'pnpm -C sidecar/recall-sdk-bridge build',
    );
  });

  it('keeps externalBin OUT of the auto-merged Windows config so cargo check passes', () => {
    // tauri-build validates externalBin existence during `cargo check`, but the
    // per-target PE launcher is only produced at release time. Declaring it in the
    // auto-merged overlay would break windows-check.yml.
    expect(windowsConf.bundle?.externalBin ?? []).not.toContain('binaries/recall-desktop-sdk');
  });

  it('merges the release overlay into the Windows release build', () => {
    expect(releaseWorkflow).toContain(
      '--config src-tauri/tauri.windows.conf.json --config src-tauri/tauri.windows.release.conf.json',
    );
  });

  it('keeps the SEA launcher bootstrap and build scripts in the sidecar package', () => {
    expect(existsSync(appUrl('sidecar/recall-sdk-bridge/build.mjs'))).toBe(true);
    expect(existsSync(appUrl('sidecar/recall-sdk-bridge/launcher-bootstrap.cjs'))).toBe(true);
    expect(sidecarPackage.scripts?.build).toBe('node build.mjs');
    expect(sidecarPackage.scripts?.['build:force']).toBe('node build.mjs --force');
    expect(sidecarPackage.devDependencies?.postject).toBeTruthy();
  });

  it('builds and verifies the launcher in release before Tauri bundles Windows', () => {
    const buildIdx = releaseWorkflow.indexOf('- name: Build Recall SDK sidecar');
    const bundleIdx = releaseWorkflow.indexOf('- name: Tauri build');

    expect(buildIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(buildIdx);
    expect(releaseWorkflow).toContain('RECALL_SIDECAR_TARGET: ${{ matrix.target }}');
    expect(releaseWorkflow).toMatch(/pnpm\s+-C\s+sidecar\/recall-sdk-bridge\s+build/);
    expect(releaseWorkflow).toContain('recall-desktop-sdk-${{ matrix.target }}.exe');
    expect(releaseWorkflow).not.toContain('skipping launcher build');
  });
});
