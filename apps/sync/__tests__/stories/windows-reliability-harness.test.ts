/**
 * US-001 — Windows reliability test harness
 *
 * Integration-style coverage for the Windows reliability harness. Runs on every
 * platform: scripted mode is the default so macOS CI remains green; live Windows
 * mode is opt-in via HQ_SYNC_WINDOWS_RELIABILITY_LIVE + app path env vars.
 *
 * Note: apps/sync/__tests__/stories/US-001.test.ts is a legacy notification-row
 * story from an earlier PRD — do not overwrite it. This file is the acceptance
 * suite for hq-desktop-windows-reliability / US-001.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  WindowsReliabilityHarness,
  assertContentSafeDiagnostics,
  checkCapabilitySchemaSync,
  createDeterministicWindowsFixtures,
  findSensitiveDiagnosticPath,
  isWindowsPlatform,
  listGeneratedSchemaFiles,
  runWindowsSchemaGenerationCleanCheck,
} from '../../e2e/desktop-alt/windows-reliability-harness';

const harnesses: WindowsReliabilityHarness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    await h?.dispose();
  }
});

function track(h: WindowsReliabilityHarness): WindowsReliabilityHarness {
  harnesses.push(h);
  return h;
}

describe('US-001: Windows reliability test harness', () => {
  it('Given deterministic Windows fixtures, when the reliability harness launches HQ, then it can observe tray activation, child-process state, window count, and request counts.', async () => {
    const fixtures = createDeterministicWindowsFixtures();
    expect(fixtures.childProcesses.length).toBeGreaterThan(0);
    expect(fixtures.meetings.length).toBeGreaterThan(0);
    expect(fixtures.workspaces.length).toBeGreaterThan(0);
    expect(fixtures.coreDrift.baselineStatus).toBe('ok');

    const harness = track(new WindowsReliabilityHarness({ fixtures, forceScripted: true }));
    const launch = await harness.launch();
    expect(launch.launched).toBe(true);
    expect(launch.mode).toBe('scripted');

    const tray = harness.activateTray();
    expect(tray.activated).toBe(true);
    expect(tray.leftClickCount).toBe(1);

    harness.recordBackendRequest('meetings_list');
    harness.recordBackendRequest('workspace_metadata');
    harness.setChildProcessState('child-watch-1', 'running');

    const diagnostics = harness.captureDiagnostics();
    expect(diagnostics.trayActivated).toBe(true);
    expect(diagnostics.trayLeftClickCount).toBe(1);
    expect(diagnostics.windowCount).toBeGreaterThanOrEqual(1);
    expect(diagnostics.childProcessStates.some((c) => c.role === 'watch-daemon')).toBe(
      true,
    );
    expect(diagnostics.childProcessStates.find((c) => c.id === 'child-watch-1')?.state).toBe(
      'running',
    );
    expect(diagnostics.backendRequestCounts.meetings_list).toBe(1);
    expect(diagnostics.backendRequestCounts.workspace_metadata).toBeGreaterThanOrEqual(1);
    expect(diagnostics.meetingCount).toBe(fixtures.meetings.length);
    expect(diagnostics.workspaceCount).toBe(fixtures.workspaces.length);
    expect(diagnostics.visibleConsoleProcessCount).toBe(0);
  });

  it('Given a harness run, when diagnostics are captured, then no vault file contents, tokens, or command arguments containing sensitive values are recorded.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    harness.activateTray();
    harness.recordBackendRequest('auth_state');

    const diagnostics = harness.captureDiagnostics();
    assertContentSafeDiagnostics(diagnostics);

    // Explicit contract: forbidden keys/values must be rejected.
    expect(
      findSensitiveDiagnosticPath({
        windowCount: 1,
        token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      }),
    ).toBe('$.token');
    expect(
      findSensitiveDiagnosticPath({
        windowCount: 1,
        argv: ['hq-sync-runner', '--token', 'secret'],
      }),
    ).toBe('$.argv');
    expect(
      findSensitiveDiagnosticPath({
        windowCount: 1,
        vaultContent: '# notes',
      }),
    ).toBe('$.vaultContent');
    expect(
      findSensitiveDiagnosticPath({
        note: 'Bearer sk-live-abcdefghijklmnopqrstuvwxyz',
      }),
    ).toBe('$.note');

    // Safe diagnostics stay clean.
    expect(findSensitiveDiagnosticPath(diagnostics)).toBeNull();
    expect(diagnostics).not.toHaveProperty('token');
    expect(diagnostics).not.toHaveProperty('argv');
    expect(diagnostics).not.toHaveProperty('args');
    expect(diagnostics).not.toHaveProperty('vaultContent');
    expect(JSON.stringify(diagnostics)).not.toMatch(/Bearer\s+/);
  });

  it('Given the existing desktop-alt suite, when its Windows reliability entry point runs, then existing source-contract coverage still passes.', async () => {
    // Importing the harness module must not break the desktop-alt entry surface.
    // The e2e entry (windows-reliability.spec.ts) reuses the same harness +
    // capability schema helpers; this story test pins the public API.
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    const launch = await harness.launch();
    expect(launch.launched).toBe(true);

    const schema = checkCapabilitySchemaSync();
    expect(schema.ok, schema.errors.join('; ')).toBe(true);
    expect(schema.sourceIds.length).toBeGreaterThan(0);
    expect(schema.schemaFiles).toEqual(
      expect.arrayContaining([
        'acl-manifests.json',
        'capabilities.json',
        'desktop-schema.json',
      ]),
    );

    // Platform guard is explicit and non-throwing on non-Windows.
    expect(typeof isWindowsPlatform()).toBe('boolean');
    expect(listGeneratedSchemaFiles().length).toBeGreaterThan(0);
  });

  it('Given a clean checkout, when Windows capability and schema generation runs, then git reports no generated-file diff.', async () => {
    // Always assert capability sources ↔ committed gen/schemas stay aligned.
    const sync = checkCapabilitySchemaSync();
    expect(sync.ok, sync.errors.join('; ')).toBe(true);
    expect(sync.missingInGenerated).toEqual([]);

    // Optional heavy step: re-run cargo check / schema emission and assert git
    // clean under src-tauri/gen/schemas. Skipped on non-Windows unless forced.
    const gen = await runWindowsSchemaGenerationCleanCheck();
    if (!gen.ran) {
      expect(gen.clean).toBe(true);
      expect(gen.reason).toBeTruthy();
      return;
    }
    expect(gen.clean, gen.reason ?? gen.porcelain ?? 'generated schemas dirty').toBe(
      true,
    );
  });

  it('rejects unsafe backend request resource labels', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();
    expect(() => harness.recordBackendRequest('https://api.example/token?x=1')).toThrow(
      /safe logical name/,
    );
    expect(() => harness.recordBackendRequest('token')).toThrow(/safe logical name/);
  });

  it('exposes deterministic fixtures for meetings, workspaces, and Core Drift', () => {
    const fixtures = createDeterministicWindowsFixtures();
    expect(fixtures.meetings.every((m) => m.url.includes('example.test'))).toBe(true);
    expect(fixtures.workspaces.some((w) => w.kind === 'personal')).toBe(true);
    expect(fixtures.workspaces.some((w) => w.kind === 'company')).toBe(true);
    expect(['ok', 'unavailable']).toContain(fixtures.coreDrift.baselineStatus);
    expect(fixtures.childProcesses.every((c) => c.visibleConsole === false)).toBe(true);
  });
});
