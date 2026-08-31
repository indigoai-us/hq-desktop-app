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

  it('buffers transitions and flushes their original timestamps only after opt-in', async () => {
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

    expect(emitted).toEqual([]);
    telemetry.bindAccount('account-a');
    await telemetry.acceptConsent();

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

  it('discards every buffered transition on decline and emits no decline event', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      emit: async (event) => {
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'setup', action: 'entered', flow: 'first_install' },
    });

    telemetry.discard();
    telemetry.bindAccount('account-a');
    await telemetry.acceptConsent();

    expect(emitted).toEqual([]);
  });

  it('keeps the install session and pending resume event across wizard remounts', async () => {
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
    first.bindAccount('account-a');
    const resumed = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => 'should-not-be-used',
      emit: async (event) => {
        emitted.push(event);
      },
    });

    expect(resumed.sessionId).toBe(first.sessionId);
    resumed.bindAccount('account-a');
    await resumed.acceptConsent();
    expect(emitted[0]?.sessionId).toBe(first.sessionId);
    expect(emitted[0]?.properties.action).toBe('entered');
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).toContain(first.sessionId);
  });

  it('retains unsent events after a delivery failure and retries them later', async () => {
    let fail = true;
    const telemetry = createOnboardingStepTelemetry({
      storage,
      emit: async (event) => {
        if (fail) throw new Error('offline');
        emitted.push(event);
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'entered', flow: 'first_install' },
    });
    telemetry.bindAccount('account-a');

    await expect(telemetry.acceptConsent()).rejects.toThrow('offline');
    expect(emitted).toEqual([]);

    fail = false;
    await telemetry.acceptConsent();
    expect(emitted).toHaveLength(1);
  });

  it('drops an existing account buffer when a different account signs in', async () => {
    const first = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '33333333-3333-4333-8333-333333333333',
      emit: async (event) => {
        emitted.push(event);
      },
    });
    first.record({
      properties: { step: 'welcome-signin', action: 'started', flow: 'first_install' },
    });
    first.bindAccount('account-a');

    const second = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => '44444444-4444-4444-8444-444444444444',
      emit: async (event) => {
        emitted.push(event);
      },
    });
    second.bindAccount('account-b');
    await second.acceptConsent();

    expect(second.sessionId).toBe('44444444-4444-4444-8444-444444444444');
    expect(emitted).toEqual([]);
  });
});
