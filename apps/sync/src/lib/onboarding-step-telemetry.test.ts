import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({ ok: true, status: 200 })),
}));

import {
  __INTERNALS__,
  CONNECTOR_IMPORT_OUTCOMES,
  CONNECTOR_IMPORT_SOURCE_SETS,
  createOnboardingStepTelemetry,
  desktopPropertiesForOnboardingStep,
  type InstallerStepPingPayload,
  type OnboardingStepEvent,
} from './onboarding-step-telemetry';
import { INSTALLER_STEP_BY_WIZARD_STEP } from './installer-step-telemetry';
import { normalizeSetupErrorKind } from './onboarding-setup';

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
  let pings: InstallerStepPingPayload[];

  beforeEach(() => {
    storage = memoryStorage();
    emitted = [];
    pings = [];
  });

  function createTelemetry(
    overrides: Parameters<typeof createOnboardingStepTelemetry>[0] = {},
  ) {
    return createOnboardingStepTelemetry({
      storage,
      emit: async (event) => {
        emitted.push(event);
      },
      pingInstallerStep: (payload) => {
        pings.push(payload);
      },
      ...overrides,
    });
  }

  it('keeps only matching bounded first-launch sign-in reach outcomes', () => {
    const reached = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'welcome-signin',
        action: 'entered',
        flow: 'first_launch',
        outcome: 'reached-signin',
      },
    });
    expect(reached.outcome).toBe('reached-signin');

    const skipped = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'welcome-signin',
        action: 'skipped',
        flow: 'first_launch',
        outcome: 'setup-resume-skip',
      },
    });
    expect(skipped.outcome).toBe('setup-resume-skip');

    const unsafe = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'welcome-signin',
        action: 'skipped',
        flow: 'first_launch',
        outcome: 'reached-signin',
        error: 'private path should not be emitted',
      } as never,
    });
    expect(unsafe).not.toHaveProperty('outcome');
    expect(unsafe).not.toHaveProperty('error');

    const wrongScope = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'directory',
        action: 'entered',
        flow: 'first_launch',
        outcome: 'reached-signin',
      },
    });
    expect(wrongScope).not.toHaveProperty('outcome');

    const wrongFlow = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'welcome-signin',
        action: 'entered',
        flow: 'first_install',
        outcome: 'reached-signin',
      },
    });
    expect(wrongFlow).not.toHaveProperty('outcome');

    const unknown = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-04T00:00:00.000Z',
      properties: {
        step: 'welcome-signin',
        action: 'skipped',
        flow: 'first_launch',
        outcome: 'free-form failure text',
      } as never,
    });
    expect(unknown).not.toHaveProperty('outcome');
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

  it('durably defers setup failure until retry outcome, then recovers unresolved rows after restart', async () => {
    const first = createTelemetry();
    const deferredId = first.recordDeferred({
      properties: { step: 'setup', action: 'failed', component: 'deps', depsOperation: 'git' },
      occurredAt: '2026-10-03T10:00:00.000Z',
    }, {
      retryAttempted: false,
      retryResult: 'skipped-flag-unreadable',
    });

    await Promise.resolve();
    expect(emitted).toEqual([]);
    expect(storage.getItem(__INTERNALS__.STORAGE_KEY)).toContain('skipped-flag-unreadable');

    const restarted = createTelemetry();
    await restarted.flush();
    expect(emitted).toMatchObject([{
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'setup', action: 'failed', component: 'deps', depsOperation: 'git',
        retryAttempted: false, retryResult: 'skipped-flag-unreadable',
      },
    }]);

    const live = createTelemetry();
    const resolvedId = live.recordDeferred({
      properties: { step: 'setup', action: 'failed', component: 'deps', depsOperation: 'node' },
    }, { retryAttempted: false, retryResult: 'not-eligible' });
    live.markDeferredRetryAttempted(resolvedId);
    live.resolveDeferred(resolvedId, { retryAttempted: true, retryResult: 'recovered' });
    await live.flush();
    expect(emitted.at(-1)?.properties).toMatchObject({ retryAttempted: true, retryResult: 'recovered' });
    expect(deferredId).not.toBe(resolvedId);
  });

  it('records first-folder-step transitions only on the desktop onboarding event path', async () => {
    const telemetry = createTelemetry();
    expect(INSTALLER_STEP_BY_WIZARD_STEP['first-folder-sync' as never]).toBeNull();

    for (const action of ['entered', 'started', 'skipped', 'completed'] as const) {
      telemetry.record({
        properties: {
          step: 'first-folder-sync' as never,
          action,
          flow: 'first_install',
        },
      });
    }
    await telemetry.flush();

    expect(emitted.map(({ properties }) => [properties.step, properties.action])).toEqual([
      ['first-folder-sync', 'entered'],
      ['first-folder-sync', 'started'],
      ['first-folder-sync', 'skipped'],
      ['first-folder-sync', 'completed'],
    ]);
    expect(pings).toEqual([]);
    expect(
      Object.keys(
        desktopPropertiesForOnboardingStep(emitted[0]!),
      ).sort(),
    ).toEqual(['action', 'appVersion', 'flow', 'platform', 'step', 'surface']);
  });

  it('keeps directory rejection reasons bounded and drops path-shaped values', () => {
    expect(normalizeSetupErrorKind('directory_nonempty_non_hq')).toBe(
      'directory_nonempty_non_hq',
    );
    expect(normalizeSetupErrorKind('directory_not_writable')).toBe(
      'directory_not_writable',
    );
    expect(normalizeSetupErrorKind('/Users/alice/Documents')).toBe('unknown');

    const properties = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-28T10:00:00.000Z',
      properties: {
        step: 'directory',
        action: 'failed',
        outcome: 'invalid_directory',
        errorKind: '/Users/alice/Documents' as never,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });

    expect(properties.errorKind).toBe('unknown');
    expect(JSON.stringify(properties)).not.toContain('/Users/alice');

    const boundedProperties = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-28T10:00:00.000Z',
      properties: {
        step: 'directory',
        action: 'failed',
        outcome: 'invalid_directory',
        errorKind: 'directory_nonempty_non_hq',
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(boundedProperties.errorKind).toBe('directory_nonempty_non_hq');
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

  it('keeps only bounded content symlink diagnostics on failed setup events', () => {
    const contentFailure = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'content',
        errorCategory: 'permission',
        errorOperation: 'remove_existing_link',
        errorIoKind: 'permission_denied',
        errorCode: 5,
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(contentFailure).toMatchObject({
      errorOperation: 'remove_existing_link',
      errorIoKind: 'permission_denied',
      errorCode: 5,
    });

    const unsafeFailure = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'content',
        errorOperation: 'C:\\Users\\sample\\HQ' as never,
        errorIoKind: '/Users/sample/HQ' as never,
        errorCode: 65_536,
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(unsafeFailure).not.toHaveProperty('errorOperation');
    expect(unsafeFailure).not.toHaveProperty('errorIoKind');
    expect(unsafeFailure).not.toHaveProperty('errorCode');
  });

  it('adds a bounded failure stage when a failed setup event omits failureStage', () => {
    const missingStage = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'deps',
        errorCategory: '/Users/alice/HQ/raw-error.txt' as never,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });

    expect(missingStage).toMatchObject({
      failureStage: 'deps',
      errorCategory: 'unknown',
    });
    expect(JSON.stringify(missingStage)).not.toContain('/Users/alice/HQ/raw-error.txt');
  });

  it('keeps only bounded deps retry outcome fields on failed setup steps', () => {
    const retryFailure = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'deps',
        retryAttempted: true,
        retryResult: 'recovered',
        depsOperation: 'git',
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(retryFailure).toMatchObject({
      component: 'deps',
      retryAttempted: true,
      retryResult: 'recovered',
      depsOperation: 'git',
    });

    const invalid = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'deps',
        retryAttempted: 'yes',
        retryResult: 'retry with npm install -g private-package',
        depsOperation: '/Users/alice/HQ/private-path',
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(invalid).not.toHaveProperty('retryAttempted');
    expect(invalid).not.toHaveProperty('retryResult');
    expect(invalid).not.toHaveProperty('depsOperation');

    const nonDeps = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'content',
        retryAttempted: true,
        retryResult: 'failed-again',
        depsOperation: 'git',
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(nonDeps).not.toHaveProperty('retryAttempted');
    expect(nonDeps).not.toHaveProperty('retryResult');
    expect(nonDeps).not.toHaveProperty('depsOperation');
  });

  it('keeps failed-run dependency, category, stages, and run identifier in telemetry', () => {
    const depsFailure = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'deps',
        failedDependency: 'node',
        errorCategory: 'network',
        setupRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(depsFailure).toMatchObject({
      component: 'deps',
      failedDependency: 'node',
      errorCategory: 'network',
      setupRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const nonDepsFailure = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'git-init',
        failedDependency: 'private-package' as never,
        errorCategory: '/Users/example/HQ/error' as never,
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(nonDepsFailure).toMatchObject({ errorCategory: 'unknown' });
    expect(nonDepsFailure).not.toHaveProperty('failedDependency');

    const completion = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-09T10:00:00.000Z',
      properties: {
        step: 'setup',
        action: 'completed',
        outcome: 'completed_with_failures',
        failedStages: ['content', 'deps', 'deps', 'indexing'] as never,
        setupRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(completion.failedStages).toEqual(['content', 'deps', 'indexing']);
    expect(completion.setupRunId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('records the bounded Claude Desktop config source and each distinguishable connector outcome', () => {
    const expectedOutcomes = [
      'tool_not_installed',
      'config_path_unavailable',
      'config_missing',
      'config_unreadable',
      'config_invalid',
      'zero_servers',
      'imported',
      'import_failed',
      'command_failed',
      'user_skipped',
      'unknown',
    ];

    expect(CONNECTOR_IMPORT_OUTCOMES).toEqual(expectedOutcomes);
    expect(CONNECTOR_IMPORT_SOURCE_SETS).toEqual([
      'claude_desktop_config',
      'unknown',
    ]);

    for (const outcome of expectedOutcomes) {
      const properties = desktopPropertiesForOnboardingStep({
        sessionId: '11111111-1111-4111-8111-111111111111',
        occurredAt: '2026-09-10T10:00:00.000Z',
        properties: {
          step: 'connector-import',
          action: outcome === 'import_failed' || outcome === 'command_failed' ? 'failed' : 'skipped',
          outcome,
          detectedSourceSet: 'claude_desktop_config',
          errorCategory: outcome === 'import_failed' ? 'exit-nonzero' : undefined,
          surface: 'desktop_installer',
          platform: 'windows',
        },
      });
      expect(properties.outcome).toBe(outcome);
      expect(properties.detectedSourceSet).toBe('claude_desktop_config');
    }
  });

  it('normalizes unrecognized connector labels and raw importer errors before transport', () => {
    const properties = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-09-10T10:00:00.000Z',
      properties: {
        step: 'connector-import',
        action: 'failed',
        outcome: 'all_my_connectors_are_here',
        detectedSourceSet: '/Users/alice/Library/Application Support/Claude' as never,
        errorCategory: 'raw importer error from alice@work.example' as never,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });

    expect(properties).toMatchObject({
      outcome: 'unknown',
      detectedSourceSet: 'unknown',
      errorCategory: 'unknown',
    });
    expect(JSON.stringify(properties)).not.toContain('alice');
    expect(JSON.stringify(properties)).not.toContain('work.example');
  });

  it('keeps only bounded company name-prefill status, never a suggested value', () => {
    const properties = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'company',
        action: 'completed',
        namePrefill: 'offered_kept',
        companyUid: 'cmp_test',
        surface: 'desktop_installer',
        platform: 'windows',
      },
    });
    expect(properties.namePrefill).toBe('offered_kept');
    expect(JSON.stringify(properties)).not.toContain('Acme');

    const invalid = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'company',
        action: 'completed',
        namePrefill: 'Acme Corporation',
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(invalid).not.toHaveProperty('namePrefill');
  });

  it('keeps invite company scope, explicit missing-scope marker, and a bounded sent count', () => {
    const completed = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'invite-teammate',
        action: 'completed',
        companyUid: 'cmp_test',
        invitesSent: 20,
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(completed).toMatchObject({ companyUid: 'cmp_test', invitesSent: 20 });

    const missing = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'invite-teammate',
        action: 'entered',
        companyUidMissing: true,
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(missing).toMatchObject({ companyUidMissing: true });

    const invalidCount = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-03T10:00:00.000Z',
      properties: {
        step: 'invite-teammate',
        action: 'completed',
        invitesSent: 21,
        surface: 'desktop_installer',
        platform: 'windows',
      } as never,
    });
    expect(invalidCount).not.toHaveProperty('invitesSent');
  });

  it('keeps an opaque setup run identifier across its events and changes it for a new run', async () => {
    const telemetry = createTelemetry({
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
    });
    telemetry.record({
      properties: {
        step: 'setup',
        action: 'started',
        component: 'deps',
        setupRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    });
    telemetry.record({
      properties: {
        step: 'setup',
        action: 'failed',
        component: 'deps',
        setupRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        failedDependency: 'qmd',
        errorCategory: 'timeout',
      },
    });
    telemetry.record({
      properties: {
        step: 'setup',
        action: 'started',
        component: 'deps',
        setupRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });

    await telemetry.flush();
    expect(emitted.map((event) => event.properties.setupRunId)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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

  it('uses the persisted first-launch gate once across a rerender and resumed wizard', async () => {
    const first = createTelemetry({
      newSessionId: () => '22222222-2222-4222-8222-222222222222',
    });

    expect(first.recordFirstLaunch()).toBe(true);
    expect(first.recordFirstLaunch()).toBe(false);
    const resumed = createTelemetry({ newSessionId: () => 'should-not-be-used' });
    expect(resumed.recordFirstLaunch()).toBe(false);

    await first.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.properties.flow).toBe('first_launch');
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

  it('migrates the compatible v2 session and pending records into the current queue schema', async () => {
    storage.setItem(
      __INTERNALS__.OLDER_STORAGE_KEY,
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
    expect(storage.getItem(__INTERNALS__.OLDER_STORAGE_KEY)).toBeNull();
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

  it('sends the anonymous installer ping even when authenticated emit has no token', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      emit: async () => {
        throw new Error('no token');
      },
      pingInstallerStep: (payload) => {
        pings.push(payload);
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'entered', flow: 'first_install' },
    });
    await Promise.resolve();

    expect(emitted).toEqual([]);
    expect(pings.map((ping) => ping.step)).toEqual(['welcome', 'signin']);
    expect(pings.every((ping) => ping.installSessionId === telemetry.sessionId)).toBe(true);
    expect(pings.every((ping) => ping.personUid === undefined)).toBe(true);
  });

  it('sends the anonymous installer ping with the same sessionId as desktop_onboarding_step', async () => {
    const telemetry = createTelemetry({
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
    });
    telemetry.record({
      properties: { step: 'directory', action: 'entered', flow: 'first_install' },
    });
    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        properties: { step: 'directory', action: 'entered' },
      },
    ]);
    expect(pings).toEqual([
      {
        installSessionId: '11111111-1111-4111-8111-111111111111',
        step: 'install',
        personUid: undefined,
      },
    ]);
    expect(pings[0]?.installSessionId).toBe(emitted[0]?.sessionId);
  });

  it('uses the shared installAttemptId for first-run onboarding event session identity', async () => {
    const telemetry = createTelemetry({
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
    });
    const installAttemptId = '22222222-2222-4222-8222-222222222222';

    telemetry.setInstallAttemptId(installAttemptId);
    telemetry.recordFirstLaunch();
    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: installAttemptId,
        properties: { step: 'welcome-signin', action: 'entered' },
      },
    ]);
    expect(pings.every((ping) => ping.installSessionId === installAttemptId)).toBe(true);
  });

  it('omits personUid before sign-in and includes it on later pings', async () => {
    const telemetry = createTelemetry({
      newSessionId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'entered', flow: 'first_install' },
    });
    telemetry.setPersonUid('prs_ada');
    telemetry.record({
      properties: { step: 'directory', action: 'completed' },
    });
    await Promise.resolve();

    expect(pings[0]?.personUid).toBeUndefined();
    expect(pings.some((ping) => ping.step === 'welcome' && ping.personUid === undefined)).toBe(
      true,
    );
    expect(pings.some((ping) => ping.step === 'signin' && ping.personUid === undefined)).toBe(
      true,
    );
    expect(pings.at(-1)).toEqual({
      installSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      step: 'install',
      personUid: 'prs_ada',
    });
  });

  it('ignores a non-prs identity so the server regex is never violated', async () => {
    const telemetry = createTelemetry();
    telemetry.setPersonUid('cognito-sub-ada');
    telemetry.record({
      properties: { step: 'setup', action: 'entered' },
    });
    await Promise.resolve();
    expect(pings[0]?.personUid).toBeUndefined();
  });

  it('still emits authenticated desktop_onboarding_step events when the anonymous ping throws', async () => {
    const telemetry = createOnboardingStepTelemetry({
      storage,
      newSessionId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      emit: async (event) => {
        emitted.push(event);
      },
      pingInstallerStep: () => {
        throw new Error('network down');
      },
    });
    telemetry.record({
      properties: { step: 'welcome-signin', action: 'started', flow: 'first_install' },
    });
    await Promise.resolve();

    expect(emitted).toMatchObject([
      {
        sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        properties: { step: 'welcome-signin', action: 'started', surface: 'desktop_installer' },
      },
    ]);
  });

  it('does not change the authenticated emit payload when the anonymous ping also fires', async () => {
    const telemetry = createTelemetry({
      newSessionId: () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    });
    telemetry.record({
      properties: {
        step: 'setup',
        action: 'failed',
        outcome: 'stage_command_failed',
        component: 'deps',
      },
      occurredAt: '2026-09-04T10:00:00.000Z',
    });
    await Promise.resolve();

    expect(emitted).toEqual([
      {
        sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        occurredAt: '2026-09-04T10:00:00.000Z',
        properties: {
          step: 'setup',
          action: 'failed',
          outcome: 'stage_command_failed',
          component: 'deps',
          appVersion: 'unknown',
          surface: 'desktop_installer',
          platform: expect.any(String),
        },
      },
    ]);
    expect(pings).toEqual([
      {
        installSessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        step: 'setup',
        personUid: undefined,
      },
    ]);
  });
});

describe('invite-teammate failure telemetry', () => {
  const base = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    occurredAt: '2026-10-02T10:00:00.000Z',
  };

  it('carries the invite errorKind and HTTP status', () => {
    const properties = desktopPropertiesForOnboardingStep({
      ...base,
      properties: {
        step: 'invite-teammate',
        action: 'failed',
        errorKind: 'plan_limit',
        statusCode: 402,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(properties.errorKind).toBe('plan_limit');
    expect(properties.statusCode).toBe(402);
  });

  it('bounds unknown kinds and bad statuses', () => {
    const properties = desktopPropertiesForOnboardingStep({
      ...base,
      properties: {
        step: 'invite-teammate',
        action: 'failed',
        errorKind: 'person@example.com' as never,
        statusCode: 9000,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(properties.errorKind).toBe('request_failed');
    expect(properties.statusCode).toBeUndefined();
    expect(JSON.stringify(properties)).not.toContain('example.com');
  });

  it('carries the company route decision, provisioning step and self-heal, bounded', () => {
    const route = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-02T10:00:00.000Z',
      properties: {
        step: 'company',
        action: 'started',
        decision: 'paid_existing',
        existingCompanies: 2,
        paidCompany: true,
        pendingInvites: 0,
        companyUid: 'cmp_a',
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(route).toMatchObject({
      decision: 'paid_existing',
      existingCompanies: 2,
      paidCompany: true,
      pendingInvites: 0,
      companyUid: 'cmp_a',
    });
    const odd = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-02T10:00:00.000Z',
      properties: {
        step: 'first-folder-sync',
        action: 'failed',
        decision: 'made up',
        provisioningStep: 'Has Spaces',
        selfHeal: 'failed',
        companyUid: 'cmp_b',
        existingCompanies: -1,
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(odd.decision).toBe('unknown');
    expect(odd.provisioningStep).toBe('unknown');
    expect(odd.selfHeal).toBe('failed');
    expect(odd.companyUid).toBe('cmp_b');
    expect(odd.existingCompanies).toBeUndefined();

    const lookupFailed = desktopPropertiesForOnboardingStep({
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-10-02T10:00:00.000Z',
      properties: {
        step: 'company',
        action: 'started',
        decision: 'lookup_failed',
        outcome: 'route_lookup_failed',
        surface: 'desktop_installer',
        platform: 'macos',
      },
    });
    expect(lookupFailed).toMatchObject({
      decision: 'lookup_failed',
      outcome: 'route_lookup_failed',
    });
  });
});
