const INSTALL_ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResolveFirstLaunchJoinKeyOptions {
  firstLaunch: boolean;
  continuationInstallAttemptId: string | null;
  isEnabled: () => Promise<boolean>;
  readNativeId: () => Promise<string | null>;
}

/** Reuse continuation identity; otherwise opt in to the native persisted id only on first launch. */
export async function resolveFirstLaunchJoinKey(
  options: ResolveFirstLaunchJoinKeyOptions,
): Promise<string | null> {
  const continuationId = options.continuationInstallAttemptId;
  const validContinuationId =
    typeof continuationId === 'string' && INSTALL_ATTEMPT_ID_RE.test(continuationId)
      ? continuationId
      : null;
  if (!options.firstLaunch) return validContinuationId;

  // On first launch, even a continuation id is only adopted early when the
  // rollout gate is enabled. The later receipt path retains its old behavior.
  let enabled = false;
  try {
    enabled = (await options.isEnabled()) === true;
  } catch (error) {
    console.warn('onboarding: first-launch join-key flag unavailable; leaving fallback off', error);
    return null;
  }
  if (!enabled) return null;

  if (validContinuationId) {
    return validContinuationId;
  }

  try {
    const nativeId = await options.readNativeId();
    return typeof nativeId === 'string' && INSTALL_ATTEMPT_ID_RE.test(nativeId)
      ? nativeId
      : null;
  } catch (error) {
    console.warn('onboarding: persisted install attempt id unavailable; leaving fallback off', error);
    return null;
  }
}
