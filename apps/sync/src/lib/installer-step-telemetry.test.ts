import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { WIZARD_STEPS, type WizardStepId } from './onboarding-wizard';
import {
  INSTALLER_STEP_BY_WIZARD_STEP,
  __resetInstallerStepTelemetryForTests,
  getInstallerStepEndpoint,
  installerStepsForOnboarding,
  isInstallerPersonUid,
  pingInstallerStep,
} from './installer-step-telemetry';

function makeResponse(status: number): Pick<Response, 'ok' | 'status'> {
  return { ok: status >= 200 && status < 300, status };
}

function posted(fetchFn: ReturnType<typeof vi.fn>, index = 0): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const call = fetchFn.mock.calls[index] as unknown as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  const [url, init] = call!;
  return { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

describe('installer step mapping', () => {
  it('covers every wizard step so a rename cannot silently fork the funnel', () => {
    const mapped = Object.keys(INSTALLER_STEP_BY_WIZARD_STEP).sort();
    const wizard = WIZARD_STEPS.map((step) => step.id).sort();
    expect(mapped).toEqual(wizard);
  });

  it('maps onto the historical five names wherever a step corresponds', () => {
    expect(INSTALLER_STEP_BY_WIZARD_STEP['welcome-signin']).toBe('signin');
    expect(INSTALLER_STEP_BY_WIZARD_STEP.directory).toBe('install');
    expect(INSTALLER_STEP_BY_WIZARD_STEP.setup).toBe('setup');
    expect(INSTALLER_STEP_BY_WIZARD_STEP.ready).toBe('done');
  });

  it('introduces new names only where the historical funnel has no equivalent', () => {
    expect(INSTALLER_STEP_BY_WIZARD_STEP.consent).toBe('consent');
    expect(INSTALLER_STEP_BY_WIZARD_STEP['connector-import']).toBe('connector-import');
  });

  it('omits post-ready extras from the install funnel', () => {
    for (const id of ['trust', 'settings', 'run-setup', 'handoff', 'build'] as const) {
      expect(INSTALLER_STEP_BY_WIZARD_STEP[id]).toBeNull();
      expect(installerStepsForOnboarding({ step: id, action: 'entered' })).toEqual([]);
    }
  });

  it('emits welcome + signin on first-run entry to the combined auth panel', () => {
    expect(
      installerStepsForOnboarding({
        step: 'welcome-signin',
        action: 'entered',
        flow: 'first_install',
      }),
    ).toEqual(['welcome', 'signin']);
    expect(
      installerStepsForOnboarding({
        step: 'welcome-signin',
        action: 'entered',
        flow: 'first_launch',
      }),
    ).toEqual(['welcome', 'signin']);
  });

  it('does not re-emit welcome on resume or on later sign-in actions', () => {
    expect(
      installerStepsForOnboarding({
        step: 'welcome-signin',
        action: 'entered',
        flow: 'resume',
      }),
    ).toEqual(['signin']);
    expect(
      installerStepsForOnboarding({
        step: 'welcome-signin',
        action: 'started',
        flow: 'first_install',
      }),
    ).toEqual(['signin']);
    expect(
      installerStepsForOnboarding({
        step: 'welcome-signin',
        action: 'completed',
      }),
    ).toEqual(['signin']);
  });

  it('maps remaining first-run panels onto a single installer step', () => {
    const cases: Array<[WizardStepId, string, string]> = [
      ['directory', 'entered', 'install'],
      ['setup', 'started', 'setup'],
      ['consent', 'entered', 'consent'],
      ['connector-import', 'skipped', 'connector-import'],
      ['ready', 'entered', 'done'],
    ];
    for (const [step, action, expected] of cases) {
      expect(installerStepsForOnboarding({ step, action })).toEqual([expected]);
    }
  });
});

describe('isInstallerPersonUid', () => {
  it('accepts vault person uids and rejects cognito subs or empty values', () => {
    expect(isInstallerPersonUid('prs_ada')).toBe(true);
    expect(isInstallerPersonUid('prs_A1-b_2')).toBe(true);
    expect(isInstallerPersonUid('cognito-sub-ada')).toBe(false);
    expect(isInstallerPersonUid('')).toBe(false);
    expect(isInstallerPersonUid(undefined)).toBe(false);
  });
});

describe('getInstallerStepEndpoint', () => {
  it('defaults to the production anonymous installer host', () => {
    expect(getInstallerStepEndpoint()).toBe(
      'https://telemetry.hq.computer/v1/installer/step',
    );
  });
});

describe('pingInstallerStep', () => {
  beforeEach(() => {
    __resetInstallerStepTelemetryForTests();
  });

  afterEach(() => {
    __resetInstallerStepTelemetryForTests();
  });

  it('POSTs with no authentication and the supplied installSessionId', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    const invokeCommand = vi.fn(async () => 'hashed-mac-abc');

    await pingInstallerStep({
      installSessionId: '11111111-1111-4111-8111-111111111111',
      step: 'signin',
      version: '0.10.192',
      now: () => 1_704_067_200_000,
      fetch: fetchFn,
      invokeCommand,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const { url, init, body } = posted(fetchFn);
    expect(url).toBe('https://telemetry.hq.computer/v1/installer/step');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(body).toEqual({
      installSessionId: '11111111-1111-4111-8111-111111111111',
      step: 'signin',
      version: '0.10.192',
      ts: 1_704_067_200_000,
      deviceId: 'hashed-mac-abc',
    });
    expect(invokeCommand).toHaveBeenCalledWith('device_fingerprint');
  });

  it('omits personUid before sign-in and includes it after a prs_* uid is known', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    const invokeCommand = vi.fn(async () => 'hashed-mac-abc');

    await pingInstallerStep({
      installSessionId: 'session',
      step: 'welcome',
      fetch: fetchFn,
      invokeCommand,
    });
    expect('personUid' in posted(fetchFn, 0).body).toBe(false);

    await pingInstallerStep({
      installSessionId: 'session',
      step: 'setup',
      personUid: 'prs_ada',
      fetch: fetchFn,
      invokeCommand,
    });
    expect(posted(fetchFn, 1).body.personUid).toBe('prs_ada');
  });

  it('does not send a non-prs identity as personUid', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    await pingInstallerStep({
      installSessionId: 'session',
      step: 'signin',
      personUid: 'cognito-sub-ada',
      fetch: fetchFn,
      invokeCommand: async () => undefined,
    });
    expect('personUid' in posted(fetchFn).body).toBe(false);
  });

  it('omits deviceId when device_fingerprint throws and still posts', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    await pingInstallerStep({
      installSessionId: 'session',
      step: 'welcome',
      version: '0.10.192',
      fetch: fetchFn,
      invokeCommand: async () => {
        throw new Error('no command');
      },
    });
    const { body } = posted(fetchFn);
    expect('deviceId' in body).toBe(false);
    expect(body.step).toBe('welcome');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never throws on a network failure', async () => {
    await expect(
      pingInstallerStep({
        installSessionId: 'session',
        step: 'done',
        fetch: async () => {
          throw new Error('network down');
        },
        invokeCommand: async () => '',
      }),
    ).resolves.toBeUndefined();
  });

  it('never throws on a non-200 response', async () => {
    await expect(
      pingInstallerStep({
        installSessionId: 'session',
        step: 'setup',
        fetch: async () => makeResponse(500),
        invokeCommand: async () => 'id',
      }),
    ).resolves.toBeUndefined();
  });

  it('does not POST when the endpoint is disabled', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    await pingInstallerStep({
      installSessionId: 'session',
      step: 'welcome',
      endpoint: null,
      fetch: fetchFn,
      invokeCommand: async () => 'id',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('posts to an explicit host override', async () => {
    const fetchFn = vi.fn(async () => makeResponse(200));
    await pingInstallerStep({
      installSessionId: 'session',
      step: 'signin',
      endpoint: 'https://hqapi.hq.computer/v1/installer/step',
      fetch: fetchFn,
      invokeCommand: async () => undefined,
    });
    expect(posted(fetchFn).url).toBe('https://hqapi.hq.computer/v1/installer/step');
  });
});
