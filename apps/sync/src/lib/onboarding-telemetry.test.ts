import { describe, expect, it, vi } from 'vitest';
import { postOptIn } from './onboarding-telemetry';

describe('postOptIn', () => {
  it('posts the opt-in choice and writes the local menubar cache', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await postOptIn({ enabled: true, invokeCommand });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'post_telemetry_opt_in', {
      enabled: true,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'write_menubar_telemetry_pref', {
      enabled: true,
    });
  });

  it('still writes the local menubar cache when the remote post fails', async () => {
    const invokeCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('vault offline'))
      .mockResolvedValueOnce(undefined);

    await postOptIn({ enabled: false, invokeCommand });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'post_telemetry_opt_in', {
      enabled: false,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'write_menubar_telemetry_pref', {
      enabled: false,
    });
  });
});
