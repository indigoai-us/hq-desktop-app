import { describe, expect, it, vi } from 'vitest';
import { emitDesktopTelemetry } from './desktop-telemetry';

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
});
