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
const daemonCommandSource = readFileSync(
  appUrl('src-tauri/src/commands/daemon.rs'),
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
const syncOutcomeSource = readFileSync(
  repoUrl('crates/hq-desktop-core/src/sync_outcome.rs'),
  'utf8',
);
const telemetrySource = readFileSync(
  repoUrl('crates/hq-telemetry/src/lib.rs'),
  'utf8',
);
const windowsReliabilityHarnessSource = readFileSync(
  appUrl('e2e/desktop-alt/windows-reliability-harness.ts'),
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
    const nextStepIdx = releaseWorkflow.indexOf('\n      - name:', bundleIdx + 1);
    const bundleStep = releaseWorkflow.slice(bundleIdx, nextStepIdx);

    expect(buildIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(buildIdx);
    expect(releaseWorkflow).toContain('RECALL_SIDECAR_TARGET: ${{ matrix.target }}');
    expect(bundleStep).toContain('RECALL_SIDECAR_TARGET: ${{ matrix.target }}');
    expect(releaseWorkflow).toMatch(/pnpm\s+-C\s+sidecar\/recall-sdk-bridge\s+build/);
    expect(releaseWorkflow).toContain('recall-desktop-sdk-${{ matrix.target }}.exe');
    expect(releaseWorkflow).not.toContain('skipping launcher build');
  });

  it('ships native x64 and ARM64 launchers without relabeling the host Node runtime', () => {
    expect(releaseWorkflow).toContain('- x86_64-pc-windows-msvc');
    expect(releaseWorkflow).toContain('- aarch64-pc-windows-msvc');
    expect(releaseWorkflow).toContain('windows-aarch64');
    expect(releaseWorkflow).toContain('RECALL_SIDECAR_NODE_EXECUTABLE');
    expect(releaseWorkflow).toContain('Get-FileHash $archive -Algorithm SHA256');
    // Both Windows architectures are required. Publishing must fail closed if
    // either updater binary or signature is missing rather than silently
    // producing a partial latest.json manifest.
    expect(releaseWorkflow).toContain('- name: Validate complete release artifact set');
    expect(releaseWorkflow).toContain('`HQ_${version}_arm64-setup.exe`');
    expect(releaseWorkflow).toContain('`HQ_${version}_arm64-setup.exe.sig`');
    expect(releaseWorkflow).toContain(
      'signature: readSig(process.env.WIN_ARM64_SIG_PATH)',
    );
    expect(releaseWorkflow).not.toContain(
      'has(process.env.WIN_ARM64_EXE_PATH) && has(process.env.WIN_ARM64_SIG_PATH)',
    );
    expect(sidecarBuildSource).toContain('["aarch64-pc-windows-msvc", 0xaa64]');
    expect(sidecarBuildSource).toContain('assertTargetArchitecture(launcherRuntime)');
  });

  it('requires Windows tests and release success', () => {
    expect(windowsCheckWorkflow).toMatch(
      /- name: Windows tests[\s\S]*cargo test --target x86_64-pc-windows-msvc --bins/,
    );
    expect(releaseWorkflow).not.toContain('continue-on-error: true');
  });

  it('keeps every native Windows Cargo gate fail-fast and runs sync outcome tests', () => {
    const workflowLines = windowsCheckWorkflow.split('\n');
    const cargoLines = workflowLines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !line.trimStart().startsWith('#'))
      .filter(({ line }) => /^\s*(?:run:\s*)?cargo (?:check|test)\b/.test(line));

    expect(cargoLines.length).toBeGreaterThanOrEqual(6);
    for (const { line, index } of cargoLines) {
      expect(line).toMatch(/^\s*run:\s*cargo (?:check|test)\b[^;&|]*$/);
      expect(workflowLines.slice(Math.max(0, index - 3), index).join('\n')).toMatch(
        /- name: /,
      );
    }
    expect(cargoLines.some(({ line }) => line.includes('sync_outcome::tests'))).toBe(true);
  });

  it('keeps session termination alertable and wired to evidence-safe Windows context', () => {
    expect(syncOutcomeSource).toContain(
      'pub const WINDOWS_SESSION_TERMINATE_EXIT: i32 = 0x4001_0004;',
    );
    expect(syncOutcomeSource).toContain('Self::SessionTerminate => "session_terminate"');
    expect(syncOutcomeSource).toContain(
      'WindowsTermination::SessionTerminate => "windows:session-terminate".to_string()',
    );
    expect(daemonCommandSource).toContain('("windows_exit_class", termination.class_name().to_string())');
    expect(daemonCommandSource).toContain('("runner_fatal_class", runner_fatal_class)');
    expect(daemonCommandSource).toContain('("windows_fault_symbol", symbol.to_string())');
    expect(daemonCommandSource).toContain(
      'let mut extras = watcher_exit_context_extras(context, runner_fatal_class_seen);',
    );
    expect(windowsCheckWorkflow).toMatch(
      /- name: Sync outcome tests[\s\S]*cargo test --manifest-path .*sync_outcome::tests/,
    );
  });

  it('wires libuv assertion identity, node major, and stdout count on both runner seams', () => {
    // The shared parser + accessors live in the core, read identically by both routes.
    expect(syncOutcomeSource).toContain(
      'pub fn runner_assert_identity(line: &str) -> Option<RunnerAssertIdentity>',
    );
    expect(syncOutcomeSource).toContain(
      'fn parse_runner_assertion(line: &str) -> Option<RunnerAssertIdentity>',
    );
    expect(syncOutcomeSource).toContain(
      "pub fn runner_assert_source(&self) -> Option<&'static str>",
    );

    // Manual route (sync.rs).
    expect(syncCommandSource).toContain(
      'tags.push(("runner_assert_source", source.to_string()));',
    );
    expect(syncCommandSource).toContain(
      'tags.push(("runner_assert_signature", signature.to_string()));',
    );
    expect(syncCommandSource).toContain('"runner_assert_line",');
    expect(syncCommandSource).toContain('"runner_stdout_line_count",');
    expect(syncCommandSource).toContain('"runner_node_major",');
    // The Node major is reused from the preflight probe — no new spawn.
    expect(syncCommandSource).toContain(
      'fn preflight_node_with_major() -> (NodePreflight, Option<u32>)',
    );

    // Watcher route (daemon.rs) — same fields from the shared source.
    expect(daemonCommandSource).toContain('tags.push(("runner_assert_source", source));');
    expect(daemonCommandSource).toContain('runner_assert_identity');
    expect(daemonCommandSource).toContain('"runner_assert_line",');
    expect(daemonCommandSource).toContain('"runner_stdout_line_count",');
    expect(daemonCommandSource).toContain('"runner_node_major",');
    // Node major inherited via the shared preflight bail — no new probe.
    expect(daemonCommandSource).toContain(
      'let (node_bail, runner_node_major) = crate::commands::sync::preflight_node_bail();',
    );
  });

  it('keeps the runner phase vocabulary identical across core, telemetry, and the harness', () => {
    // 1) Core: the single-source RUNNER_PHASE_VOCABULARY const.
    const coreMatch = syncOutcomeSource.match(
      /pub const RUNNER_PHASE_VOCABULARY:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/,
    );
    expect(coreMatch).not.toBeNull();
    const coreTokens = [...coreMatch![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(coreTokens).toEqual(['idle', 'pre_protocol', 'pull', 'push', 'scan', 'unknown']);

    // 2) Telemetry: the validator's runner_phase egress arm.
    const telemetryMatch = telemetrySource.match(
      /"runner_phase"\s*=>\s*Some\(matches!\(\s*value,\s*([^)]*)\)\)/,
    );
    expect(telemetryMatch).not.toBeNull();
    const telemetryTokens = [...telemetryMatch![1].matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .sort();
    expect(telemetryTokens).toEqual(coreTokens);

    // 3) Harness: the TS RunnerPhase union.
    const harnessMatch = windowsReliabilityHarnessSource.match(
      /export type RunnerPhase\s*=\s*([^;]*);/,
    );
    expect(harnessMatch).not.toBeNull();
    const harnessTokens = [...harnessMatch![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(harnessTokens).toEqual(coreTokens);
  });

  it('keeps raw watcher stderr local instead of copying it into Sentry breadcrumbs', () => {
    const stderrStart = daemonCommandSource.indexOf('ProcessEvent::Stderr(line) => {');
    const exitStart = daemonCommandSource.indexOf('ProcessEvent::Exit {', stderrStart);
    const stderrArm = daemonCommandSource.slice(stderrStart, exitStart);

    expect(stderrStart).toBeGreaterThan(-1);
    expect(exitStart).toBeGreaterThan(stderrStart);
    expect(stderrArm).toContain('log("daemon.stderr", &line)');
    expect(stderrArm).toContain('handle_runner_stderr_line(&app, &totals, &line)');
    expect(stderrArm).not.toContain('sentry::add_breadcrumb');
  });

  it('keeps manual runner stderr content-safe at the source and at telemetry egress', () => {
    const stderrStart = syncCommandSource.indexOf('ProcessEvent::Stderr(line) => {');
    const exitStart = syncCommandSource.indexOf('ProcessEvent::Exit {', stderrStart);
    const stderrArm = syncCommandSource.slice(stderrStart, exitStart);

    expect(stderrStart).toBeGreaterThan(-1);
    expect(exitStart).toBeGreaterThan(stderrStart);
    expect(stderrArm).toContain('log("runner.stderr", &line)');
    expect(stderrArm).toContain('handle_runner_stderr_line(&app_bg, &totals, &line)');
    expect(stderrArm).toContain('runner_stderr_breadcrumb');
    expect(stderrArm).not.toContain('message: Some(line.clone())');
    expect(telemetrySource).toContain('is_raw_process_stream_category');
    expect(telemetrySource).toContain('is_content_safe_runner_stderr_message');
    expect(telemetrySource).not.toContain(
      'breadcrumb.category.as_deref() == Some("daemon.stderr")',
    );
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
