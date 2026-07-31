import { describe, expect, it, vi } from 'vitest';
import { surfaceNativeNotificationRetry } from './nativeNotificationRecovery';

describe('surfaceNativeNotificationRetry', () => {
  it('returns no in-app recovery when the retry banner is created', async () => {
    const recovery = await surfaceNativeNotificationRetry(
      { kind: 'dm', action: 'open', data: { eventId: 'dm-1' } },
      {
        showRetryBanner: vi.fn().mockResolvedValue(undefined),
        showMainWindow: vi.fn(),
      },
    );

    expect(recovery).toBeNull();
  });

  it('returns durable in-app recovery and attempts to reveal it when banner creation fails', async () => {
    const showMainWindow = vi.fn().mockRejectedValue(new Error('window busy'));
    const recovery = await surfaceNativeNotificationRetry(
      { kind: 'share', action: 'copy', data: { paths: ['brief.md'] } },
      {
        showRetryBanner: vi.fn().mockRejectedValue(new Error('banner unavailable')),
        showMainWindow,
      },
    );

    expect(showMainWindow).toHaveBeenCalledOnce();
    expect(recovery).toEqual({
      kind: 'share',
      action: 'copy',
      data: { paths: ['brief.md'] },
      message: 'Couldn’t finish the shared-item action. Retry it here.',
    });
  });
});
