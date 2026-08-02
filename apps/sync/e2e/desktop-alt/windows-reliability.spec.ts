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
    expect(abort.execProvenance).toBe('npx_cache');
    expect(abort.targetExists).toBe(true);
    expect(abort.targetExecutable).toBe(false);
    assertContentSafeDiagnostics(abort);
    expect(JSON.stringify(abort)).not.toContain('async.c');
    expect(JSON.stringify(abort)).not.toContain('hq-sync-runner');
  });
});
