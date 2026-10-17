export type SignInProvider = 'Google' | 'Microsoft';

function parseStructuredOAuthError(
  message: string,
): { code?: string; message?: string } | null {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      message: typeof record.message === 'string' ? record.message : undefined,
    };
  } catch {
    return null;
  }
}

const SIGN_IN_TIMEOUT_COPY = 'Sign-in took too long. Choose a provider to try again.';

/**
 * True when the person is shown "Sign-in took too long" for this error. A
 * structured or state-mismatch error that happens to say "expired" shows its
 * own message, so it is not a timeout.
 */
export function isSignInTimeout(message: string): boolean {
  return mapSignInError(message) === SIGN_IN_TIMEOUT_COPY;
}

export function mapSignInError(message: string, provider?: SignInProvider): string {
  const structured = parseStructuredOAuthError(message);

  if (structured?.code === 'OAUTH_REFERRAL_PERSIST_FAILED') {
    return 'We couldn’t finish preparing sign-in. Please try again.';
  }

  if (structured?.code === 'OAUTH_PORT_IN_USE') {
    return (
      structured.message ||
      'Sign-in could not open a registered local callback port (53682, 8765, or 3000). Close another sign-in window or app using one, then retry.'
    );
  }

  if (structured?.code === 'OAUTH_PROVIDER_ERROR') {
    return structured.message || 'Sign-in was cancelled or denied. Retry when you are ready.';
  }

  if (
    structured?.code === 'MICROSOFT_EMAIL_REQUIRED' ||
    structured?.code === 'MICROSOFT_ENABLEMENT_REQUIRED' ||
    structured?.code === 'MICROSOFT_RESOLVE_FAILED'
  ) {
    return (
      structured.message ||
      'We could not identify your Microsoft account. Check your connection and retry.'
    );
  }

  if (/state (mismatch|does not match)/i.test(message)) {
    return 'That sign-in attempt no longer matches. Choose a provider to start again.';
  }

  if (/expired|timed out waiting for sign-in/i.test(message)) {
    return SIGN_IN_TIMEOUT_COPY;
  }

  if (/token exchange/i.test(message)) {
    return "We couldn't finish sign-in after the browser step. Check your connection and retry.";
  }

  if (/desktop bridge|invoke|open.*browser|shell/i.test(message)) {
    return `Could not start ${provider ?? 'provider'} sign-in from this environment. Open HQ as the desktop app and try again.`;
  }

  console.warn('[signin] sign-in failed', message);
  return 'Sign-in did not finish. Choose your provider and try again.';
}
