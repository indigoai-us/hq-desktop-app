export type NativeNotificationActionKind = 'dm' | 'share';

export interface NativeNotificationAction {
  kind: NativeNotificationActionKind;
  action: string;
  data: unknown;
}

export interface NativeNotificationRecovery extends NativeNotificationAction {
  message: string;
}

interface NativeNotificationRecoveryPorts {
  showRetryBanner: (action: NativeNotificationAction) => Promise<void>;
  showMainWindow: () => Promise<void>;
  onError?: (message: string, error: unknown) => void;
}

function recoveryMessage(kind: NativeNotificationActionKind): string {
  return kind === 'dm'
    ? 'Couldn’t finish the message action. Retry it here.'
    : 'Couldn’t finish the shared-item action. Retry it here.';
}

/**
 * Prefer the compact custom Retry banner. If creating that surface fails,
 * return an App-owned recovery record and reveal the main popover best-effort.
 * The caller retains the record until its direct retry succeeds.
 */
export async function surfaceNativeNotificationRetry(
  action: NativeNotificationAction,
  ports: NativeNotificationRecoveryPorts,
): Promise<NativeNotificationRecovery | null> {
  try {
    await ports.showRetryBanner(action);
    return null;
  } catch (error) {
    ports.onError?.('notification retry banner failed', error);
  }

  try {
    await ports.showMainWindow();
  } catch (error) {
    // The recovery record remains durable in App state and will be visible the
    // next time the popover opens even when it cannot be revealed immediately.
    ports.onError?.('notification recovery window failed', error);
  }

  return {
    ...action,
    message: recoveryMessage(action.kind),
  };
}
