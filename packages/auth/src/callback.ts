/**
 * Safe post-sign-in destination resolution.
 *
 * Only a single-slash absolute path is honored; protocol-relative
 * ("//evil.com"), backslash-smuggled ("/\\evil.com"), and off-origin values
 * collapse to "/". The request origin is required so URL parsing verifies that
 * control characters and other parser-normalized values remain same-origin.
 */

export type SignInSearchParams = {
  callbackUrl?: string;
  return?: string;
  "return-to"?: string;
  error?: string;
  idp?: string;
  provider?: string;
};

export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Resolve a safe, same-origin post-sign-in destination. */
export function normalizeCallback(
  searchParams: SignInSearchParams,
  origin: string,
): string {
  const callbackUrl = firstParam(searchParams.callbackUrl);
  const returnUrl = firstParam(searchParams.return);
  const returnTo = firstParam(searchParams["return-to"]);
  const raw = callbackUrl || returnUrl || returnTo || "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }

  try {
    const requestOrigin = new URL(origin);
    return new URL(raw, requestOrigin).origin === requestOrigin.origin
      ? raw
      : "/";
  } catch {
    return "/";
  }
}

/**
 * Build a SignInSearchParams object from a URLSearchParams. Kept separate so
 * normalizeCallback stays a pure, host-agnostic guard.
 */
export function searchParamsToSignIn(
  params: URLSearchParams,
): SignInSearchParams {
  const at = (k: string) => params.get(k) ?? undefined;
  return {
    callbackUrl: at("callbackUrl"),
    return: at("return"),
    "return-to": at("return-to"),
    error: at("error"),
    idp: at("idp"),
    provider: at("provider"),
  };
}
