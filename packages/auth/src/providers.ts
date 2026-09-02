/**
 * Sign-in provider → Cognito identity-provider map.
 *
 * Each enabled provider deep-links to Cognito's /oauth2/authorize with
 * `identity_provider=<identityProvider>`, so Cognito skips its generic hosted
 * chooser and jumps straight to that IdP.
 *
 * `enabled` gates whether a live button ships: the app's Cognito app client
 * currently registers [COGNITO, Google] ONLY. Microsoft (MicrosoftPersonal) is
 * NOT registered, so a live Microsoft deep-link would 400 at Cognito — it
 * renders disabled ("coming soon") until the IdP is added to the client. Flip
 * `enabled` to true once registered.
 */

export const SIGNIN_PROVIDERS = ["Google", "Microsoft"] as const;
export type SignInProvider = (typeof SIGNIN_PROVIDERS)[number];

export interface SignInProviderConfig {
  label: string;
  /** Cognito `identity_provider` value on the authorize URL. */
  identityProvider: string;
  /** Whether the IdP is registered on this app client (safe to deep-link). */
  enabled: boolean;
}

export const SIGNIN_PROVIDER_CONFIG = {
  Google: {
    label: "Google",
    identityProvider: "Google",
    enabled: true,
  },
  Microsoft: {
    label: "Microsoft",
    identityProvider: "MicrosoftPersonal",
    enabled: false,
  },
} as const satisfies Record<SignInProvider, SignInProviderConfig>;

export function isAllowedSignInProvider(
  value: string,
): value is SignInProvider {
  return SIGNIN_PROVIDERS.includes(value as SignInProvider);
}

/** Allowed AND registered on the app client (safe to redirect to Cognito). */
export function isEnabledSignInProvider(
  value: string,
): value is SignInProvider {
  return (
    isAllowedSignInProvider(value) && SIGNIN_PROVIDER_CONFIG[value].enabled
  );
}
