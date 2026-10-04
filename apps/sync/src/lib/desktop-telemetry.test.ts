import { describe, expect, it, vi } from 'vitest';
import {
  emitPlanLimitPromptTelemetry,
  emitDesktopOperationalTelemetry,
  emitDesktopOperationalTelemetryStrict,
  emitDesktopAuthFailure,
  emitDesktopAuthProgress,
  classifyDesktopAuthError,
  emitDesktopTelemetry,
  emitDesktopTelemetryStrict,
} from './desktop-telemetry';

function promptFetch(flagValue: boolean) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/v1/flags/resolve') {
      return new Response(
        JSON.stringify({ version: 1, flags: { 'billing.limit-at-action-prompt': flagValue } }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('emitDesktopTelemetry', () => {
  it('invokes the consent-gated desktop telemetry command', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await emitDesktopTelemetry({
      eventName: 'manual_sync_completed',
      properties: { filesDownloaded: 3 },
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenCalledWith('emit_desktop_telemetry_if_opted_in', {
      eventName: 'manual_sync_completed',
      properties: { filesDownloaded: 3 },
    });
  });

  it('does not throw when telemetry emission fails', async () => {
    const invokeCommand = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      emitDesktopTelemetry({
        eventName: 'manual_sync_failed',
        invokeCommand,
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps delivery failures visible to durable telemetry queues', async () => {
    const invokeCommand = vi.fn().mockRejectedValue(new Error('offline'));

    await expect(
      emitDesktopTelemetryStrict({
        eventName: 'desktop_onboarding_step',
        invokeCommand,
      }),
    ).rejects.toThrow('offline');
  });

  it('forwards envelope session and product-seam timestamps', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await emitDesktopTelemetry({
      eventName: 'desktop_onboarding_step',
      properties: { step: 'welcome-signin', action: 'entered' },
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-08-31T10:00:00.000Z',
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenCalledWith('emit_desktop_telemetry_if_opted_in', {
      eventName: 'desktop_onboarding_step',
      properties: { step: 'welcome-signin', action: 'entered' },
      sessionId: '11111111-1111-4111-8111-111111111111',
      occurredAt: '2026-08-31T10:00:00.000Z',
    });
  });

  it('invokes the operational command without depending on the skill opt-in', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await emitDesktopOperationalTelemetry({
      eventName: 'desktop_onboarding_step',
      properties: { step: 'setup', action: 'completed' },
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenCalledWith('emit_desktop_operational_telemetry', {
      eventName: 'desktop_onboarding_step',
      properties: { step: 'setup', action: 'completed' },
    });
  });

  it('keeps operational delivery failures visible to the authentication queue', async () => {
    const invokeCommand = vi.fn().mockRejectedValue(new Error('no token'));

    await expect(
      emitDesktopOperationalTelemetryStrict({
        eventName: 'desktop_onboarding_step',
        invokeCommand,
      }),
    ).rejects.toThrow('no token');
  });
});

describe('desktop auth operational telemetry', () => {
  it('emits bounded progress and failure facts without forwarding raw errors', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await emitDesktopAuthProgress({
      provider: 'google',
      step: 'callback_received',
      invokeCommand,
    });
    await emitDesktopAuthFailure({
      provider: 'google',
      step: 'callback_received',
      error: new Error('OAuth callback timed out with code=do-not-send'),
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'emit_desktop_operational_telemetry', {
      eventName: 'desktop_auth_progress',
      properties: { provider: 'google', step: 'callback_received' },
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'emit_desktop_operational_telemetry', {
      eventName: 'desktop_auth_failure',
      properties: {
        provider: 'google',
        step: 'callback_received',
        errorCategory: 'timeout',
      },
    });
    expect(JSON.stringify(invokeCommand.mock.calls)).not.toContain('do-not-send');
  });

  it('uses closed error categories for sign-in failures', () => {
    expect(classifyDesktopAuthError(new Error('provider denied access'))).toBe('cancelled');
    expect(classifyDesktopAuthError(new Error('TLS certificate failed'))).toBe('tls');
    expect(classifyDesktopAuthError({})).toBe('unknown');
  });
});

describe('emitPlanLimitPromptTelemetry', () => {
  it('sends bounded authenticated v2 exposure and engagement events only when the HQ flag is on', async () => {
    const { calls, fetchFn } = promptFetch(true);

    await emitPlanLimitPromptTelemetry({
      fetch: fetchFn,
      eventName: 'plan_limit_prompt_exposed',
      companyUid: 'cmp_acme',
      exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
      occurredAt: '2026-09-29T12:00:00.000Z',
    });
    await emitPlanLimitPromptTelemetry({
      fetch: fetchFn,
      eventName: 'plan_limit_prompt_engaged',
      companyUid: 'cmp_acme',
      exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
      action: 'upgrade_clicked',
      occurredAt: '2026-09-29T12:00:01.000Z',
    });

    const posts = calls.filter(({ input }) => input === '/v1/telemetry/events');
    expect(posts).toHaveLength(2);
    const exposure = JSON.parse(String(posts[0].init?.body)).events[0];
    expect(exposure).toMatchObject({
      eventName: 'plan_limit_prompt_exposed',
      companyUid: 'cmp_acme',
      schemaVersion: 2,
      consentBasis: 'no-consent',
      occurredAt: '2026-09-29T12:00:00.000Z',
      properties: {
        surface: 'desktop_sync_limit_notice',
        resourceKind: 'storageBytes',
        presentationKind: 'advisory',
        exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
      },
    });
    expect(exposure.idempotencyKey).toContain('exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a');
    const engagement = JSON.parse(String(posts[1].init?.body)).events[0];
    expect(engagement).toMatchObject({
      eventName: 'plan_limit_prompt_engaged',
      companyUid: 'cmp_acme',
      properties: {
        surface: 'desktop_sync_limit_notice',
        resourceKind: 'storageBytes',
        presentationKind: 'advisory',
        exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
        action: 'upgrade_clicked',
      },
    });
  });

  it('does not post exposure or engagement while the HQ flag is off', async () => {
    const { calls, fetchFn } = promptFetch(false);

    await emitPlanLimitPromptTelemetry({
      fetch: fetchFn,
      eventName: 'plan_limit_prompt_exposed',
      companyUid: 'cmp_acme',
      exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
    });
    await emitPlanLimitPromptTelemetry({
      fetch: fetchFn,
      eventName: 'plan_limit_prompt_engaged',
      companyUid: 'cmp_acme',
      exposureId: 'exposure:3d50d3ab-4266-4d29-8fda-f9132d0a6c7a',
      action: 'upgrade_clicked',
    });

    expect(calls.map(({ input }) => input)).toEqual([
      '/v1/flags/resolve',
      '/v1/flags/resolve',
    ]);
  });
});
