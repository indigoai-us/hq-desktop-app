import { describe, expect, it, vi } from 'vitest';
import {
  resolveStartupState,
  startupSurface,
  type StartupProbeResult,
} from './startup-gate';

const signedIn: StartupProbeResult = {
  lifecycleState: 'SteadyState',
  hadStoredToken: true,
  auth: { authenticated: true, expiresAt: '2030-01-01T00:00:00Z' },
};

const notSetUp: StartupProbeResult = {
  lifecycleState: 'NeedsInstall',
  hadStoredToken: false,
  auth: { authenticated: false, expiresAt: null },
};

describe('startupSurface', () => {
  it('shows the loading surface until the probe resolves', () => {
    expect(
      startupSurface({ phase: 'loading', lifecycleState: null, authenticated: false }),
    ).toBe('loading');
  });

  it('never shows the Welcome card on the way to a signed-in machine', () => {
    const surfaces = [
      startupSurface({ phase: 'loading', lifecycleState: null, authenticated: false }),
      startupSurface({
        phase: 'resolved',
        lifecycleState: 'SteadyState',
        authenticated: true,
      }),
    ];
    expect(surfaces).toEqual(['loading', 'signed-in']);
    expect(surfaces).not.toContain('onboarding');
    expect(surfaces).not.toContain('sign-in');
  });

  it('shows the Welcome card once the probe resolves to not-set-up', () => {
    expect(
      startupSurface({
        phase: 'resolved',
        lifecycleState: 'NeedsInstall',
        authenticated: false,
      }),
    ).toBe('onboarding');
    expect(
      startupSurface({
        phase: 'resolved',
        lifecycleState: 'NeedsAuthForInstall',
        authenticated: false,
      }),
    ).toBe('onboarding');
  });

  it('shows the sign-in card for a real session loss on a set-up machine', () => {
    expect(
      startupSurface({
        phase: 'resolved',
        lifecycleState: 'SteadyState',
        authenticated: false,
      }),
    ).toBe('sign-in');
  });

  it('treats an unknown lifecycle state as no onboarding route', () => {
    expect(
      startupSurface({ phase: 'resolved', lifecycleState: null, authenticated: true }),
    ).toBe('signed-in');
  });
});

describe('resolveStartupState', () => {
  it('retries a transient failure and reports the resolved state', async () => {
    const probe = vi
      .fn<() => Promise<StartupProbeResult>>()
      .mockRejectedValueOnce(new Error('ipc not ready'))
      .mockResolvedValueOnce(signedIn);
    const onRetry = vi.fn();

    const outcome = await resolveStartupState(probe, {
      delayMs: 0,
      sleep: async () => {},
      onRetry,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, result: signedIn, attempts: 2 });
  });

  it('never reports signed-out when every attempt fails', async () => {
    const err = new Error('token store unreadable');
    const probe = vi.fn<() => Promise<StartupProbeResult>>().mockRejectedValue(err);

    const outcome = await resolveStartupState(probe, {
      attempts: 3,
      delayMs: 0,
      sleep: async () => {},
    });

    expect(probe).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual({ ok: false, error: err, attempts: 3 });
    // A failed probe holds the loading surface — it is not a verdict.
    expect(
      startupSurface({ phase: 'loading', lifecycleState: null, authenticated: false }),
    ).toBe('loading');
  });

  it('does not retry a probe that resolves first time', async () => {
    const probe = vi.fn<() => Promise<StartupProbeResult>>().mockResolvedValue(notSetUp);

    const outcome = await resolveStartupState(probe, { sleep: async () => {} });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ ok: true, result: notSetUp, attempts: 1 });
  });

  it('backs off between attempts', async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
    const probe = vi
      .fn<() => Promise<StartupProbeResult>>()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValueOnce(signedIn);

    await resolveStartupState(probe, { delayMs: 100, sleep });

    expect(sleep.mock.calls.map((c) => c[0])).toEqual([100, 200]);
  });
});
