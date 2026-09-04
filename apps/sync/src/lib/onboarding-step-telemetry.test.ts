import { beforeEach, describe, expect, it } from 'vitest';
import {
  __INTERNALS__,
  createOnboardingStepTelemetry,
  type OnboardingStepEvent,
} from './onboarding-step-telemetry';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

describe('onboarding step telemetry', () => {
  let storage: Storage;
  let emitted: OnboardingStepEvent[];

  beforeEach(() => {
    storage = memoryStorage();
    emitted = [];
  });

  it('emits setup transitions immediately, before a consent choice exists', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
      emit: async (event) => {
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'entered', flow: 'first_install' },
      occurredAt: '2026-08-31T10:00:00.000Z',
    });
    telemetry.record({
      properties: { step: 'directory', action: 'completed' },
      occurredAt: '2026-08-31T10:01:00.000Z',
    });

    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        occurredAt: '2026-08-31T10:00:00.000Z',
        properties: { step: 'welcome-signin', action: 'entered', surface: 'desktop_installer' },
      },
      {
        occurredAt: '2026-08-31T10:01:00.000Z',
        properties: { step: 'directory', action: 'completed' },
      },
    ]);
  });

  it('continues to emit operational setup after a person declines skill telemetry', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      emit: async (event) => {
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'setup', action: 'entered', flow: 'first_install' },
    });
    // The consent preference is owned by skill telemetry; it never alters this
    // operational trace.
    telemetry.record({
      properties: { step: 'setup', action: 'failed', outcome: 'stage_command_failed' },
    });
    await Promise.resolve();

    expect(emitted).toMatchObject([
      { properties: { step: 'setup', action: 'entered' } },
      { properties: { step: 'setup', action: 'failed' } },
    ]);
  });

  it('keeps the install session across wizard remounts without retaining an event buffer', async () => {
    const first = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '22222222-2222-4222-8222-222222222222',
      emit: async (event) => {
        emitted.push(event);
      },
    });
    first.record({
      properties: { step: 'directory', action: 'entered', flow: 'resume' },
      occurredAt: '2026-08-31T10:00:00.000Z',
    });
    const resumed = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => 'should-not-be-used',
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(resumed.sessionId).toBe(first.sessionId);
    await Promise.resolve();
    expect(emitted[0]?.sessionId).toBe(first.sessionId);
    expect(emitted[0]?.properties.action).toBe('entered');
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).toContain(first.sessionId);
  });

  it('buffers a pre-auth operational event and flushes it after authentication', async () => {
    let authenticated = false;
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '44444444-4444-4444-8444-444444444444',
      emit: async (event) => {
        if (!authenticated) throw new Error('no token');
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'entered', flow: 'first_install' },
    });
    await Promise.resolve();

    expect(emitted).toEqual([]);
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).toContain('welcome-signin');
    await expect(telemetry.flush()).rejects.toThrow('no token');

    authenticated = true;
    await telemetry.flush();

    expect(emitted).toMatchObject([
      {
        sessionId: '44444444-4444-4444-8444-444444444444',
        properties: { step: 'welcome-signin', action: 'entered' },
      },
    ]);
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).not.toContain('welcome-signin');
  });

  it('does not associate operational setup events with an account', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '33333333-3333-4333-8333-333333333333',
      emit: async (event) => {
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'started', flow: 'first_install' },
    });
    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: '33333333-3333-4333-8333-333333333333',
        properties: { step: 'welcome-signin', action: 'started' },
      },
    ]);
  });

  it('migrates the compatible v2 session and pending records before creating v3', async () => {
    storage.setItem(
      __INTERNALS__.LEGACY_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        sessionId: '55555555-5555-4555-8555-555555555555',
        firstLaunchRecorded: true,
        pending: [
          {
            sessionId: '55555555-5555-4555-8555-555555555555',
            occurredAt: '2026-08-31T10:00:00.000Z',
            properties: {
              step: 'welcome-signin',
              action: 'entered',
              surface: 'desktop_installer',
              platform: 'macos',
            },
          },
        ],
      }),
    );
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => 'should-not-be-used',
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(telemetry.sessionId).toBe('55555555-5555-4555-8555-555555555555');
    expect(storage.getItem(__INTERNALS__.LEGACY_STORAGE_KEY)).toBeNull();
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).toContain('"firstLaunchRecorded":true');

    await telemetry.flush();
    telemetry.recordFirstLaunch();
    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: '55555555-5555-4555-8555-555555555555',
        properties: { step: 'welcome-signin', action: 'entered' },
      },
    ]);
    expect(emitted).toHaveLength(1);
  });
});
