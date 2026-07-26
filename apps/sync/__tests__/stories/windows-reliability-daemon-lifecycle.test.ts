/**
 * US-002 — Stable daemon lifecycle and hidden background processes
 *
 * Scripted harness coverage for watch-daemon lifecycle (Stopped → Starting →
 * Running → Backoff), app-owned handle authority without a PID file, single
 * Job Object teardown, hidden probes, and content-safe diagnostics.
 *
 * Note: apps/sync/__tests__/stories/US-002.test.ts is a legacy floating-widget
 * story — do not overwrite it. This file is the acceptance suite for
 * hq-desktop-windows-reliability / US-002.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  WindowsReliabilityHarness,
  assertContentSafeDiagnostics,
  findSensitiveDiagnosticPath,
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

describe('US-002: Stable daemon lifecycle and hidden background processes', () => {
  it('Given the daemon is stopped, when a fake long-lived child spawns, then state progresses through Starting to Running.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const lifecycle = harness.simulateWatchDaemonLifecycle({ startDeadlines: 2 });
    expect(lifecycle.states[0]).toBe('stopped');
    expect(lifecycle.states).toContain('starting');
    expect(lifecycle.states).toContain('running');
    expect(lifecycle.states[lifecycle.states.length - 1]).toBe('running');
    expect(lifecycle.visibleConsole).toBe(false);
  });

  it('Given a healthy child without a PID file, when the supervisor checks for at least two start deadlines, then the same process tree remains alive and no force-clear occurs.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const lifecycle = harness.simulateWatchDaemonLifecycle({ startDeadlines: 2 });
    expect(lifecycle.remainedRunning).toBe(true);
    expect(lifecycle.forceClearCount).toBe(0);

    const diagnostics = harness.captureDiagnostics();
    const watch = diagnostics.childProcessStates.find((c) => c.role === 'watch-daemon');
    expect(watch?.state).toBe('running');
    expect(watch?.visibleConsole).toBe(false);
  });

  it('Given a child crash, heartbeat stall, or cancellation, when teardown completes, then descendants exit once and a backoff-controlled restart can succeed.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    for (const failure of ['crash', 'heartbeat-stall', 'cancelled'] as const) {
      const result = harness.simulateWatchDaemonFailureRestart(failure);
      expect(result.jobTerminateCount).toBe(1);
      expect(result.restarted).toBe(true);
      expect(result.states).toContain('running');
      expect(result.diagnostic.category).toMatch(/crash|heartbeat_stall|cancelled/);
      assertContentSafeDiagnostics({
        state: result.diagnostic.state,
        category: result.diagnostic.category,
      });
    }
  });

  it('Given background AI-tool probes and sync startup, when they run on Windows, then no console window becomes visible.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    // Background children must stay hidden; fixtures model CREATE_NO_WINDOW.
    for (const child of harness.getFixtures().childProcesses) {
      expect(child.visibleConsole).toBe(false);
    }

    harness.setChildProcessState('child-probe-1', 'running');
    harness.setChildProcessState('child-watch-1', 'running');
    const diagnostics = harness.captureDiagnostics();
    expect(diagnostics.visibleConsoleProcessCount).toBe(0);
    expect(
      diagnostics.childProcessStates.every((c) => c.visibleConsole === false),
    ).toBe(true);
  });

  it('Given daemon failures, when diagnostics are emitted, then they contain lifecycle state and category but no sensitive arguments or content.', async () => {
    const harness = track(new WindowsReliabilityHarness({ forceScripted: true }));
    await harness.launch();

    const result = harness.simulateWatchDaemonFailureRestart('crash');
    const payload = {
      state: result.diagnostic.state,
      failureCategory: result.diagnostic.category,
      windowCount: 0,
      visibleConsoleProcessCount: 0,
    };
    assertContentSafeDiagnostics(payload);
    expect(findSensitiveDiagnosticPath(payload)).toBeNull();

    expect(
      findSensitiveDiagnosticPath({
        state: 'running',
        argv: ['hq-sync-runner', '--token', 'secret'],
      }),
    ).toBe('$.argv');
    expect(
      findSensitiveDiagnosticPath({
        state: 'running',
        token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig',
      }),
    ).toBe('$.token');

    const diagnostics = harness.captureDiagnostics();
    assertContentSafeDiagnostics(diagnostics);
    expect(JSON.stringify(diagnostics)).not.toMatch(/Bearer\s+/);
    expect(diagnostics).not.toHaveProperty('args');
    expect(diagnostics).not.toHaveProperty('commandLine');
  });
});
