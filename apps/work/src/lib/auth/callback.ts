/**
 * Work-web return-to guard. The shared helper keeps the common parameter
 * vocabulary, while this host-bound check has the request origin available to
 * reject any value that URL parsing would resolve off-origin.
 */

import {
  firstParam,
  searchParamsToSignIn,
  type SignInSearchParams,
} from "@hq/auth";

export { firstParam, searchParamsToSignIn, type SignInSearchParams };

export function normalizeCallback(
  searchParams: SignInSearchParams,
  origin?: string,
): string {
  const callbackUrl = firstParam(searchParams.callbackUrl);
  const returnUrl = firstParam(searchParams.return);
  const returnTo = firstParam(searchParams["return-to"]);
  const raw = callbackUrl || returnUrl || returnTo || "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/";
  }
  if (!origin) return raw;

  try {
    const requestOrigin = new URL(origin);
    return new URL(raw, requestOrigin).origin === requestOrigin.origin
      ? raw
      : "/";
  } catch {
    return "/";
  }
}
