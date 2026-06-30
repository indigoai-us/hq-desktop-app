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

export function mapSignInError(message: string, provider?: SignInProvider): string {
  const structured = parseStructuredOAuthError(message);

  if (structured?.code === 'OAUTH_PORT_IN_USE') {
    return (
      structured.message ||
      'Sign-in needs local port 53682, but another process is already using it. Close the other sign-in window or app using that port, then retry.'
    );
  }

  if (structured?.code === 'OAUTH_PROVIDER_ERROR') {
    return structured.message || 'Sign-in was cancelled or denied. Retry when you are ready.';
  }

  if (/token exchange/i.test(message)) {
    return "We couldn't finish sign-in after the browser step. Check your connection and retry.";
  }

  if (/desktop bridge|invoke|open.*browser|shell/i.test(message)) {
    return `Could not start ${provider ?? 'provider'} sign-in from this environment. Open HQ as the desktop app and try again.`;
  }

  return message || 'Sign-in failed';
}
