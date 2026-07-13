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
const windowsCheckWorkflow = readFileSync(
  repoUrl('.github/workflows/windows-check.yml'),
  'utf8',
);
const sidecarBuildSource = readFileSync(
  appUrl('sidecar/recall-sdk-bridge/build.mjs'),
  'utf8',
);
const syncMainSource = readFileSync(appUrl('src-tauri/src/main.rs'), 'utf8');
const syncCommandSource = readFileSync(
  appUrl('src-tauri/src/commands/sync.rs'),
  'utf8',
);
const widgetSource = readFileSync(
  appUrl('src-tauri/src/commands/widget.rs'),
  'utf8',
);
const settingsSource = readFileSync(
  appUrl('src-tauri/src/commands/settings.rs'),
  'utf8',
);
const frontendMainSource = readFileSync(appUrl('src/main.ts'), 'utf8');
const popoverSource = readFileSync(
  appUrl('src/components/Popover.svelte'),
  'utf8',
);
const prewarmSource = readFileSync(
  repoUrl('crates/hq-desktop-core/src/prewarm.rs'),
  'utf8',
);

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

  it('ships only the Windows architecture backed by a native Recall payload', () => {
    expect(releaseWorkflow).toContain('- x86_64-pc-windows-msvc');
    expect(releaseWorkflow).not.toContain('- aarch64-pc-windows-msvc');
    expect(releaseWorkflow).not.toContain('windows-aarch64');
    expect(sidecarBuildSource).toContain(
      'const SUPPORTED_TARGET = "x86_64-pc-windows-msvc"',
    );
  });

  it('requires Windows tests and release success', () => {
    expect(windowsCheckWorkflow).toMatch(
      /- name: Windows tests[\s\S]*cargo test --target x86_64-pc-windows-msvc --bins/,
    );
    expect(releaseWorkflow).not.toContain('continue-on-error: true');
  });

  it('builds and launches the Windows executable through the live driver harness', () => {
    expect(windowsCheckWorkflow).toContain('cargo install tauri-driver');
    expect(windowsCheckWorkflow).toContain('pnpm tauri build --debug --no-bundle');
    expect(windowsCheckWorkflow).toContain('HQ_SYNC_DESKTOP_ALT_LIVE: "1"');
    expect(windowsCheckWorkflow).toContain('HQ_SYNC_DESKTOP_ALT_APP:');
    expect(windowsCheckWorkflow).toContain('smoke-pages.spec.ts');
  });

  it('keeps release builds console-free and background npm work hidden', () => {
    expect(syncMainSource).toContain(
      '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
    );
    expect(prewarmSource).toContain('paths::spawn_command(');
    expect(syncCommandSource).toContain('paths::spawn_command(&npx_bin');
  });

  it('uses native Node and npx probes on Windows', () => {
    expect(syncCommandSource).toContain('paths::resolve_bin("node")');
    expect(syncCommandSource).toContain('node_version_command()');
    expect(syncCommandSource).toContain('paths::resolve_bin("npx")');
    expect(syncCommandSource).toContain('this computer');
  });

  it('defaults the floating widget off on Windows without changing macOS', () => {
    expect(widgetSource).toContain('fn default_widget_enabled() -> bool');
    expect(widgetSource).toContain('!cfg!(target_os = "windows")');
    expect(widgetSource).toContain('unwrap_or_else(default_widget_enabled)');
    expect(settingsSource).toContain('default_widget_enabled()');
  });

  it('uses an opaque popover surface fallback on Windows', () => {
    expect(frontendMainSource).toContain("dataset.platform = isWindows ? 'windows' : 'other'");
    expect(popoverSource).toContain(":global(html[data-platform='windows']) .mbpop");
    expect(popoverSource).toContain('backdrop-filter: none');
  });

});
