/**
 * desktop-alt entry point — Windows reliability (US-001).
 *
 * Source-contract + scripted harness coverage that remains compatible with the
 * existing macOS desktop-alt suite. Live Windows process observation is opt-in
 * via HQ_SYNC_WINDOWS_RELIABILITY_LIVE; default path is always scripted so CI on
 * any OS keeps passing.
 *
 * Also pins the capability/schema generation invariant: committed
 * gen/schemas must reflect capability sources, and optional generation leaves
 * the worktree clean.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import {
  WindowsReliabilityHarness,
  assertContentSafeDiagnostics,
  checkCapabilitySchemaSync,
  createDeterministicWindowsFixtures,
  isWindowsPlatform,
  runWindowsSchemaGenerationCleanCheck,
} from './windows-reliability-harness';

const harnesses: WindowsReliabilityHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.dispose();
  }
});

function track(h: WindowsReliabilityHarness): WindowsReliabilityHarness {
  harnesses.push(h);
  return h;
}

describe('desktop-alt Windows reliability entry (US-001)', () => {
  it('launches with deterministic fixtures and records content-safe diagnostics', async () => {
    const fixtures = createDeterministicWindowsFixtures();
    const harness = track(
      new WindowsReliabilityHarness({ fixtures, forceScripted: true }),
    );

    const launch = await harness.launch();
    expect(launch.launched).toBe(true);
    // Default CI path is scripted on every OS, including Windows.
    expect(launch.mode).toBe('scripted');

    const tray = harness.activateTray();
    expect(tray.activated).toBe(true);

    harness.recordBackendRequest('workspace_metadata');
    harness.recordBackendRequest('core_drift_status');

    const diagnostics = harness.captureDiagnostics();
    assertContentSafeDiagnostics(diagnostics);

    expect(diagnostics.windowCount).toBeGreaterThanOrEqual(1);
    expect(diagnostics.trayActivated).toBe(true);
    expect(diagnostics.childProcessStates.length).toBe(fixtures.childProcesses.length);
    expect(diagnostics.visibleConsoleProcessCount).toBe(0);
    expect(diagnostics.backendRequestCounts.workspace_metadata).toBeGreaterThanOrEqual(1);
    expect(diagnostics.backendRequestCounts.core_drift_status).toBe(1);
    expect(diagnostics.meetingCount).toBe(fixtures.meetings.length);
    expect(diagnostics.workspaceCount).toBe(fixtures.workspaces.length);
    expect(diagnostics.coreDriftBaselineStatus).toBe('ok');
  });

  it('keeps diagnostics free of vault contents, tokens, and sensitive argv', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    const diagnostics = harness.captureDiagnostics();

    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      'vaultContent',
      'accessToken',
      'refreshToken',
      '"argv"',
      '"args"',
      'Bearer ',
      'cognito-tokens',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    assertContentSafeDiagnostics(diagnostics);
  });

  it('stays compatible with existing desktop-alt source-contract helpers', () => {
    // Smoke that the shared harness module still resolves repo sources the
    // rest of the desktop-alt suite relies on (macOS + Windows).
    const conf = readRepoFile('src-tauri/tauri.conf.json');
    expect(conf).toContain('"label": "desktop-alt"');

    const main = readRepoFile('src-tauri/src/main.rs');
    expect(main).toContain('commands::desktop_alt::');

    // Windows platform marker remains in the frontend entry (parity surface).
    const frontendMain = readRepoFile('src/main.ts');
    expect(frontendMain).toContain("dataset.platform = isWindows ? 'windows' : 'other'");

    // Capability sources exist for windows that the reliability suite will grow into.
    const capabilitiesDir = join(process.cwd(), 'src-tauri', 'capabilities');
    const capabilityFiles = readdirSync(capabilitiesDir).filter((f) => f.endsWith('.json'));
    expect(capabilityFiles).toEqual(
      expect.arrayContaining(['default.json', 'desktop-alt.json', 'drift-detail.json']),
    );

    for (const file of ['default.json', 'desktop-alt.json']) {
      const raw = JSON.parse(readFileSync(join(capabilitiesDir, file), 'utf8')) as {
        identifier: string;
        permissions: unknown[];
      };
      expect(raw.identifier).toBeTruthy();
      expect(raw.permissions.length).toBeGreaterThan(0);
    }

    expect(typeof isWindowsPlatform()).toBe('boolean');
  });

  it('keeps Windows capability sources and committed gen/schemas aligned', () => {
    const sync = checkCapabilitySchemaSync();
    expect(sync.ok, sync.errors.join('; ')).toBe(true);
    expect(sync.missingInGenerated).toEqual([]);
    expect(sync.schemaFiles).toEqual(
      expect.arrayContaining([
        'acl-manifests.json',
        'capabilities.json',
        'desktop-schema.json',
      ]),
    );
  });

  it('Windows capability and schema generation leaves the repository worktree unchanged', async () => {
    // Static alignment always runs. The cargo-driven regeneration clean-check
    // runs on Windows (or when HQ_SYNC_WINDOWS_SCHEMA_GEN=1) and otherwise
    // reports a clear skip reason without failing macOS CI.
    const sync = checkCapabilitySchemaSync();
    expect(sync.ok, sync.errors.join('; ')).toBe(true);

    const gen = await runWindowsSchemaGenerationCleanCheck();
    if (!gen.ran) {
      expect(gen.clean).toBe(true);
      expect(gen.reason).toMatch(/HQ_SYNC_WINDOWS_SCHEMA_GEN=1|not found/i);
      return;
    }
    expect(
      gen.clean,
      `expected clean gen/schemas worktree after generation; porcelain:\n${gen.porcelain ?? ''}\n${gen.reason ?? ''}`,
    ).toBe(true);
  });
});

describe('desktop-alt Windows reliability — daemon lifecycle (US-002)', () => {
  it('progresses Stopped → Starting → Running for a fake long-lived child without a PID file', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    const lifecycle = harness.simulateWatchDaemonLifecycle({ startDeadlines: 2 });
    expect(lifecycle.states[0]).toBe('stopped');
    expect(lifecycle.states).toEqual(
      expect.arrayContaining(['stopped', 'starting', 'running']),
    );
    expect(lifecycle.remainedRunning).toBe(true);
    expect(lifecycle.forceClearCount).toBe(0);
    expect(lifecycle.visibleConsole).toBe(false);
  });

  it('tears down Job Object once on crash/stall/cancel and allows restart', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    for (const failure of ['crash', 'heartbeat-stall', 'cancelled'] as const) {
      const result = harness.simulateWatchDaemonFailureRestart(failure);
      expect(result.jobTerminateCount).toBe(1);
      expect(result.restarted).toBe(true);
    }
  });

  it('keeps background probe and daemon fixtures console-hidden', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    const diagnostics = harness.captureDiagnostics();
    expect(diagnostics.visibleConsoleProcessCount).toBe(0);
    expect(diagnostics.childProcessStates.every((c) => !c.visibleConsole)).toBe(true);
  });

  it('exposes a fatal runner abort through fixed-vocabulary diagnostics only', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const abort = harness.simulateRunnerFatalAbort();
    expect(abort.fatalClass).toBe('libuv_assert');
    expect(abort.windowsFaultSymbol).toBe('STATUS_STACK_BUFFER_OVERRUN');
    assertContentSafeDiagnostics(abort);
    expect(JSON.stringify(abort)).not.toContain('async.c');
    expect(JSON.stringify(abort)).not.toContain('hq-sync-runner');
  });

  it('reports exec-permission target state as unknown instead of inferring it', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const denied = harness.simulateRunnerExecPermissionFailure();
    expect(denied.fatalClass).toBe('exec_permission_denied');
    expect(denied.execResolution).toBe('npx_cache');
    expect(denied.targetExists).toBe('unknown');
    expect(denied.targetExecutable).toBe('unknown');
    assertContentSafeDiagnostics(denied);
    expect(JSON.stringify(denied)).not.toContain('hq-sync-runner');
    expect(JSON.stringify(denied)).not.toContain('/.npm/_npx/');
  });

  it('pins watcher and manual termination context as a fixture-backed artifact contract', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const watcherExec = harness.simulateRunnerTerminationDiagnostics({
      route: 'watcher',
      origin: 'supervisor_respawn',
      phase: 'unknown',
      exitCode: 126,
      stderr: [],
    });
    expect(watcherExec.route).toBe('watcher');
    expect(watcherExec.launchOrigin).toBe('supervisor_respawn');
    expect(watcherExec.stackShape).toBe('all_redacted');
    expect(watcherExec.stackSignature).toBe('unknown');

    const watcherFault = harness.simulateRunnerTerminationDiagnostics({
      route: 'watcher',
      origin: 'app_launch',
      phase: 'pull',
      exitCode: 0xc0000409,
      stderr: ['at node:internal/modules/cjs/loader:1218:14', 'at node:fs:242:9'],
    });
    expect(watcherFault.windowsExitStatus).toBe('0xC0000409');
    expect(watcherFault.windowsFaultSymbol).toBe('STATUS_STACK_BUFFER_OVERRUN');
    expect(watcherFault.stackShape).toBe('node_cjs_loader>node_fs');

    const manualFault = harness.simulateRunnerTerminationDiagnostics({
      route: 'manual',
      phase: 'push',
      exitCode: 0xc0000409,
      stderr: ['at node:internal/process/task_queues:95:5'],
    });
    expect(manualFault.route).toBe('manual');
    expect(manualFault.phase).toBe('push');
    expect(manualFault.windowsExitStatus).toBe(watcherFault.windowsExitStatus);
    expect(manualFault.windowsFaultSymbol).toBe(watcherFault.windowsFaultSymbol);

    // HQ-DESKTOP-50: a libuv abort now carries WHICH assertion, whether the
    // runner produced protocol, and which Node ran it — never the raw bytes.
    const assertAbort = harness.simulateRunnerTerminationDiagnostics({
      route: 'manual',
      phase: 'pre_protocol',
      exitCode: 0xc0000409,
      stderr: [
        'Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76',
      ],
      stdoutLineCount: 0,
      nodeMajor: 20,
    });
    expect(assertAbort.fatalClass).toBe('libuv_assert');
    expect(assertAbort.phase).toBe('pre_protocol');
    expect(assertAbort.assertSource).toBe('libuv_win_async');
    expect(assertAbort.assertLine).toBe(76);
    expect(assertAbort.assertSignature).toMatch(/^[0-9a-f]{16}$/);
    expect(assertAbort.stdoutLineCount).toBe(0);
    expect(assertAbort.nodeMajor).toBe(20);

    // A DIFFERENT assertion in the same source yields a distinct signature —
    // the discriminating identity the base revision collapsed to one value.
    const assertAbortB = harness.simulateRunnerTerminationDiagnostics({
      route: 'watcher',
      origin: 'supervisor_respawn',
      phase: 'pull',
      exitCode: 0xc0000409,
      stderr: ['Assertion failed: handle->async_sent == 0, file src\\win\\async.c, line 112'],
      stdoutLineCount: 4,
      nodeMajor: 22,
    });
    expect(assertAbortB.assertSource).toBe('libuv_win_async');
    expect(assertAbortB.assertLine).toBe(112);
    expect(assertAbortB.assertSignature).not.toBe(assertAbort.assertSignature);
    expect(assertAbortB.stdoutLineCount).toBe(4);
    expect(assertAbortB.nodeMajor).toBe(22);

    for (const diagnostic of [
      watcherExec,
      watcherFault,
      manualFault,
      assertAbort,
      assertAbortB,
    ]) {
      assertContentSafeDiagnostics(diagnostic);
      const serialized = JSON.stringify(diagnostic);
      for (const forbidden of [
        'async.c',
        'hq-sync-runner',
        '/.npm/_npx/',
        'private-company',
        'UV_HANDLE_CLOSING',
        'async_sent',
        'handle->flags',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('pins the 0xC0000409 watcher fast-fail as an attributed artifact contract', async () => {
    // The exact status behind HQ-DESKTOP-3S (raw -1073740791) and
    // HQ-DESKTOP-4C (decoded 0xC0000409). The live event carried the Windows
    // classification but no route, no launch origin and no stack shape, so
    // triage could not tell which entry point started the dying generation.
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const fastFail = harness.simulateRunnerTerminationDiagnostics({
      route: 'watcher',
      origin: 'supervisor_respawn',
      phase: 'scan',
      exitCode: 0xc0000409,
      stderr: [
        '<--- Last few GCs --->',
        'FATAL ERROR: Ineffective mark-compacts near heap limit '
          + 'Allocation failed - JavaScript heap out of memory',
        'at Module._compile (node:internal/modules/cjs/loader:1356:14)',
        'at node:fs:242:9',
      ],
    });

    // Preserved classification.
    expect(fastFail.windowsExitStatus).toBe('0xC0000409');
    expect(fastFail.windowsFaultSymbol).toBe('STATUS_STACK_BUFFER_OVERRUN');
    expect(fastFail.phase).toBe('scan');
    expect(fastFail.elapsedPhaseBucket).toBe('under_1m');

    // New attribution — same vocabulary the native capture seam emits.
    expect(fastFail.route).toBe('watcher');
    expect(fastFail.launchOrigin).toBe('supervisor_respawn');
    expect(fastFail.stackShape).toBe('app>app>node_cjs_loader>node_fs');
    expect(fastFail.stackDepth).toBe(4);
    expect(fastFail.redactedFrames).toBe(2);
    expect(fastFail.stackSignature).not.toBe('unknown');
    expect(fastFail.stackSignature).toMatch(/^[0-9a-f]{16}$/);

    // A silent __fastfail flushes nothing. That is a discriminating datum, so
    // the degraded stack is reported honestly while route and origin still land.
    const silent = harness.simulateRunnerTerminationDiagnostics({
      route: 'watcher',
      origin: 'renderer',
      phase: 'idle',
      exitCode: 0xc0000409,
      stderr: [],
    });
    expect(silent.stackShape).toBe('all_redacted');
    expect(silent.stackSignature).toBe('unknown');
    expect(silent.stackDepth).toBe(0);
    expect(silent.redactedFrames).toBe(0);
    expect(silent.route).toBe('watcher');
    expect(silent.launchOrigin).toBe('renderer');

    for (const diagnostic of [fastFail, silent]) {
      assertContentSafeDiagnostics(diagnostic);
      const serialized = JSON.stringify(diagnostic);
      for (const forbidden of [
        'JavaScript heap out of memory',
        'Module._compile',
        'node:internal/modules/cjs/loader',
        'Last few GCs',
        'hq-sync-runner',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('keeps native route, origin, phase, and stack vocabularies wired to production callers', () => {
    const core = readRepoFile('../../crates/hq-desktop-core/src/sync_outcome.rs');
    const daemon = readRepoFile('src-tauri/src/commands/daemon.rs');
    const main = readRepoFile('src-tauri/src/main.rs');

    for (const token of [
      'node_task_queues',
      'node_cjs_loader',
      'node_fs',
      'libuv_win_async',
      'all_redacted',
    ]) {
      expect(core).toContain(`"${token}"`);
    }
    for (const origin of ['renderer', 'app_launch', 'supervisor_respawn']) {
      expect(daemon).toContain(`"${origin}"`);
    }
    // The fixture harness mirrors this fallback; if production drops it, the
    // artifact contract above would silently stop describing real captures.
    expect(core).toContain('fn parenthesized_runtime_frame_token');
    expect(main).toContain('start_daemon_for_app_launch(handle)');
    expect(daemon).toContain('start_daemon_for_supervisor_respawn(handle.clone())');
  });
});
