import { describe, expect, it, vi } from 'vitest';
import {
  emitDesktopOperationalTelemetry,
  emitDesktopOperationalTelemetryStrict,
  emitDesktopTelemetry,
  emitDesktopTelemetryStrict,
} from './desktop-telemetry';

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
