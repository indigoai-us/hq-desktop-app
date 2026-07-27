import { describe, expect, it, vi } from 'vitest';
import { postOptIn } from './onboarding-telemetry';

describe('postOptIn', () => {
  /**
   * Order changed deliberately (was: POST first, then cache).
   *
   * The local write stamps the answer with the account that gave it, reading
   * the Cognito subject at call time. The remote POST retries for up to ~15
   * seconds and a sign-out does not cancel it — so caching afterwards meant a
   * user who answered and then signed out could have their answer stored under
   * the NEXT account's subject, letting that account's consent repair replay a
   * choice it never made.
   */
  it('caches the choice locally BEFORE uploading it', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await postOptIn({ enabled: true, invokeCommand });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'write_menubar_telemetry_pref', {
      enabled: true,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'post_telemetry_opt_in', {
      enabled: true,
    });
  });

  it('still uploads when the local cache write fails', async () => {
    const invokeCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);

    await postOptIn({ enabled: false, invokeCommand });

    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'post_telemetry_opt_in', {
      enabled: false,
    });
  });

  it('still caches locally when the remote post fails', async () => {
    // The whole point of the local record: the answer survives a failed upload,
    // and the consent repair replays it once the person entity exists.
    const invokeCommand = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('vault offline'));

    await postOptIn({ enabled: false, invokeCommand });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'write_menubar_telemetry_pref', {
      enabled: false,
    });
    expect(invokeCommand).toHaveBeenCalledTimes(2);
  });
});
