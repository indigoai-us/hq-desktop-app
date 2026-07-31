import { describe, expect, it, vi } from 'vitest';
import { markConsentRepromptShown, postOptIn } from './onboarding-telemetry';

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

  it('caches provenance (surface + consent version) locally so an offline replay can restate it', async () => {
    // Finding #7: the local cache must carry the surface + consent version, not
    // just the answer. Otherwise an offline self-heal replay posts a version-less
    // record the server reads as stale, re-prompting against wording already
    // answered. Both the cache write AND the remote write now carry provenance.
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await postOptIn({
      enabled: true,
      surface: 'onboarding',
      consentVersion: 1,
      invokeCommand,
    });

    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'write_menubar_telemetry_pref', {
      enabled: true,
      surface: 'onboarding',
      consentVersion: 1,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'post_telemetry_opt_in', {
      enabled: true,
      surface: 'onboarding',
      consentVersion: 1,
    });
  });

  it('omits provenance keys entirely when not provided', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    await postOptIn({ enabled: false, invokeCommand });

    const uploadArgs = invokeCommand.mock.calls[1][1];
    expect(uploadArgs).toEqual({ enabled: false });
    expect('surface' in uploadArgs).toBe(false);
    expect('consentVersion' in uploadArgs).toBe(false);
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

  // US-002: the remote outcome is REPORTED, not swallowed. A failed upload used
  // to be indistinguishable from a refusal — the caller must now be able to tell
  // "the server refused to record this" from "the person said no".
  it('reports a confirmed upload as uploaded:true (never throws)', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    const result = await postOptIn({ enabled: true, invokeCommand });

    expect(result).toEqual({ cached: true, uploaded: true });
  });

  it('reports a failed upload as uploaded:false with the error, and still cached', async () => {
    const invokeCommand = vi
      .fn()
      .mockResolvedValueOnce(undefined) // local cache write succeeds
      .mockRejectedValueOnce(new Error('HTTP 500')); // remote POST fails

    const result = await postOptIn({ enabled: true, invokeCommand });

    expect(result.uploaded).toBe(false);
    expect(result.cached).toBe(true);
    expect(result.error).toContain('HTTP 500');
  });

  it('reports cached:false when even the local write fails but the upload lands', async () => {
    const invokeCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full')) // local cache write fails
      .mockResolvedValueOnce(undefined); // remote POST succeeds

    const result = await postOptIn({ enabled: false, invokeCommand });

    expect(result).toEqual({ cached: false, uploaded: true });
  });
});

describe('markConsentRepromptShown', () => {
  // Finding #8: the guard is written when the re-prompt is DISPLAYED, and its
  // success is REPORTED so the caller (App.svelte) can refuse to arm an
  // unguarded prompt that would nag every launch. Previously the guard was only
  // written after an action, and any failure was swallowed.
  it('returns true when the guard write succeeds', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(undefined);

    const ok = await markConsentRepromptShown(1, 'prs_alice', invokeCommand);

    expect(ok).toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('mark_consent_reprompt_shown', {
      consentVersion: 1,
      personUid: 'prs_alice',
    });
  });

  it('returns false (never throws) when the guard write fails', async () => {
    const invokeCommand = vi.fn().mockRejectedValue(new Error('disk full'));

    const ok = await markConsentRepromptShown(1, 'prs_alice', invokeCommand);

    // Reported, not swallowed: the caller can defer the prompt rather than show
    // an unguarded one that repeats on every launch.
    expect(ok).toBe(false);
  });
});
