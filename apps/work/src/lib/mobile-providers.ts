/**
 * Sign-in providers for the phone.
 *
 * `SIGNIN_PROVIDER_CONFIG` in `@hq/auth` describes the work web app's Cognito
 * client, where Microsoft is not registered. The phone signs in to
 * `VAULT_CLIENT_ID`, the same client as the desktop app, which accepts Google,
 * `MicrosoftPersonal` and the per-organisation `MsOrg*` providers. So the
 * phone keeps its own map and resolves Microsoft the way desktop does
 * (`crates/hq-desktop-core/src/microsoft_org.rs`): ask hq-pro which provider
 * owns the email, then open Cognito straight at that provider.
 *
 * Every message below is the desktop app's existing copy.
 */

export const MOBILE_SIGNIN_PROVIDERS = ["Google", "Microsoft"] as const;
export type MobileSignInProvider = (typeof MOBILE_SIGNIN_PROVIDERS)[number];

export const MOBILE_SIGNIN_PROVIDER_LABEL: Record<MobileSignInProvider, string> = {
  Google: "Google",
  Microsoft: "Microsoft",
};

export function isMobileSignInProvider(value: unknown): value is MobileSignInProvider {
  return MOBILE_SIGNIN_PROVIDERS.includes(value as MobileSignInProvider);
}

/** Cognito IdP for Microsoft consumer accounts (outlook.com, hotmail.com, live.com). */
export const MICROSOFT_PERSONAL_PROVIDER = "MicrosoftPersonal";

/** hq-pro `MICROSOFT_ORG_PROVIDER_NAME_RE`: `MsOrg` plus 26 lowercase hex characters. */
const MICROSOFT_ORG_PROVIDER_NAME = /^MsOrg[0-9a-f]{26}$/;

export const MICROSOFT_EMAIL_REQUIRED =
  "Enter the Microsoft email you use with HQ, then try again.";
export const MICROSOFT_EMAIL_INVALID =
  "Enter a valid Microsoft email, then try again.";
export const MICROSOFT_RESOLVE_NETWORK =
  "We could not identify your Microsoft account. Check your connection and retry.";
/**
 * Also used when the organisation still needs enabling. Desktop's copy for
 * that case names "HQ Desktop", which is wrong on a phone; this one points at
 * the same fix (sign in at hqforwork.com first).
 */
export const MICROSOFT_RESOLVE_UNEXPECTED =
  "We could not identify your Microsoft account. Retry, or sign in at hqforwork.com first.";

export class MicrosoftResolveError extends Error {}

/** Trim, lowercase and reject the same values hq-pro's resolve route rejects. */
export function normalisedMicrosoftEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed === "") throw new MicrosoftResolveError(MICROSOFT_EMAIL_REQUIRED);
  // eslint-disable-next-line no-control-regex
  if (trimmed.length > 320 || /[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new MicrosoftResolveError(MICROSOFT_EMAIL_INVALID);
  }
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    throw new MicrosoftResolveError(MICROSOFT_EMAIL_INVALID);
  }
  return trimmed;
}

/** Map a resolve response body to a Cognito `identity_provider`. */
export function identityProviderFromResolveBody(body: unknown): string {
  const status =
    typeof body === "object" && body !== null
      ? (body as { status?: unknown }).status
      : undefined;
  switch (status) {
    case "enabled": {
      const name = (body as { providerName?: unknown }).providerName;
      // A work or school account must never fall back to MicrosoftPersonal:
      // login.live.com would tell the person their username does not exist.
      if (typeof name === "string" && MICROSOFT_ORG_PROVIDER_NAME.test(name)) {
        return name;
      }
      throw new MicrosoftResolveError(MICROSOFT_RESOLVE_UNEXPECTED);
    }
    case "personal":
    case "not-microsoft":
      return MICROSOFT_PERSONAL_PROVIDER;
    default:
      // Includes "enablement-required".
      throw new MicrosoftResolveError(MICROSOFT_RESOLVE_UNEXPECTED);
  }
}

/**
 * Ask hq-pro which Microsoft provider owns `email`.
 *
 * The route is unauthenticated, so no token is sent. Any failure throws a
 * `MicrosoftResolveError` whose message is safe to show as-is.
 */
export async function resolveMicrosoftIdentityProvider(
  email: string,
  deps: { apiBase: string; fetchImpl?: typeof globalThis.fetch },
): Promise<string> {
  const normalised = normalisedMicrosoftEmail(email);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(
      `${deps.apiBase.replace(/\/+$/, "")}/v1/signin/microsoft-org/resolve`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: normalised }),
        credentials: "omit",
      },
    );
  } catch {
    throw new MicrosoftResolveError(MICROSOFT_RESOLVE_NETWORK);
  }
  if (response.status === 400) {
    throw new MicrosoftResolveError(MICROSOFT_EMAIL_INVALID);
  }
  if (!response.ok) {
    throw new MicrosoftResolveError(MICROSOFT_RESOLVE_NETWORK);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MicrosoftResolveError(MICROSOFT_RESOLVE_UNEXPECTED);
  }
  return identityProviderFromResolveBody(body);
}
