/**
 * US-002 — Sync: HQ Work install detection + launcher + handoff flag.
 *
 * Tests the real `src/lib/hq-work.ts` module against a mock invoker (the
 * Tauri boundary). Detection is state, not a setup trigger.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  HQ_WORK_BUNDLE_ID,
  detectHqWorkInstalled,
  getHqWorkHandoff,
  hqWorkHandoffEnabled,
  launchHqWork,
  setHqWorkHandoff,
  type HqWorkInvoker,
} from '../../src/lib/hq-work';

const SETUP_COMMANDS = [
  'get_setup_status',
  'detect_hq',
  'start_oauth_login',
  'is_first_run',
  'open_desktop_alt_window',
];

function mockInvoker(
  impl?: (command: string, args?: Record<string, unknown>) => unknown,
): HqWorkInvoker & { calls: Array<{ command: string; args?: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const fn = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    return impl?.(command, args);
  }) as HqWorkInvoker;
  return Object.assign(fn, { calls });
}

describe('US-002 HQ Work detection, launch, and handoff flag', () => {
  it('hqWorkHandoffEnabled defaults false unless explicitly true', () => {
    expect(hqWorkHandoffEnabled(undefined)).toBe(false);
    expect(hqWorkHandoffEnabled(null)).toBe(false);
    expect(hqWorkHandoffEnabled(false)).toBe(false);
    expect(hqWorkHandoffEnabled(true)).toBe(true);
  });

  it('bundle id is ai.getindigo.hq-work', () => {
    expect(HQ_WORK_BUNDLE_ID).toBe('ai.getindigo.hq-work');
  });

  it('detectHqWorkInstalled calls only hq_work_installed, never setup/onboarding', async () => {
    const invokeFn = mockInvoker(() => true);
    const installed = await detectHqWorkInstalled(invokeFn);
    expect(installed).toBe(true);
    expect(invokeFn.calls.map((c) => c.command)).toEqual(['hq_work_installed']);
    for (const forbidden of SETUP_COMMANDS) {
      expect(invokeFn.calls.map((c) => c.command)).not.toContain(forbidden);
    }
  });

  it('launchHqWork with null url invokes launch_hq_work { url: null }', async () => {
    const invokeFn = mockInvoker();
    await launchHqWork(invokeFn, null);
    expect(invokeFn.calls).toEqual([
      { command: 'launch_hq_work', args: { url: null } },
    ]);
  });

  it('launchHqWork with a channel URL passes that url through', async () => {
    const invokeFn = mockInvoker();
    await launchHqWork(invokeFn, 'hqwork://open?channel=X');
    expect(invokeFn.calls).toEqual([
      {
        command: 'launch_hq_work',
        args: { url: 'hqwork://open?channel=X' },
      },
    ]);
  });

  it('getHqWorkHandoff and setHqWorkHandoff round-trip through the invoker', async () => {
    let stored = false;
    const invokeFn = mockInvoker((command, args) => {
      if (command === 'get_hq_work_handoff') return stored;
      if (command === 'set_hq_work_handoff') {
        stored = Boolean(args?.enabled);
        return undefined;
      }
      return undefined;
    });
    expect(await getHqWorkHandoff(invokeFn)).toBe(false);
    await setHqWorkHandoff(invokeFn, true);
    expect(await getHqWorkHandoff(invokeFn)).toBe(true);
    expect(invokeFn.calls.map((c) => c.command)).toEqual([
      'get_hq_work_handoff',
      'set_hq_work_handoff',
      'get_hq_work_handoff',
    ]);
    expect(invokeFn.calls[1].args).toEqual({ enabled: true });
  });

  it('installed + flag-on launches a channel URL', async () => {
    const invokeFn = mockInvoker((command) => {
      if (command === 'hq_work_installed') return true;
      if (command === 'get_hq_work_handoff') return true;
      return undefined;
    });
    const installed = await detectHqWorkInstalled(invokeFn);
    const flag = await getHqWorkHandoff(invokeFn);
    expect(installed).toBe(true);
    expect(hqWorkHandoffEnabled(flag)).toBe(true);
    if (installed && hqWorkHandoffEnabled(flag)) {
      await launchHqWork(invokeFn, 'hqwork://open?channel=X');
    }
    expect(invokeFn.calls.map((c) => c.command)).toEqual([
      'hq_work_installed',
      'get_hq_work_handoff',
      'launch_hq_work',
    ]);
    expect(invokeFn.calls[2].args).toEqual({
      url: 'hqwork://open?channel=X',
    });
    for (const forbidden of SETUP_COMMANDS) {
      expect(invokeFn.calls.map((c) => c.command)).not.toContain(forbidden);
    }
  });
});
