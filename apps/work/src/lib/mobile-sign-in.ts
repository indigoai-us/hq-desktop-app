/**
 * The four states a phone's shell renders from.
 *
 * The web app knows whether it is signed in before it paints: the root layout
 * reads a same-origin session. A phone has neither a server nor a cookie, so
 * it has to try its stored refresh token over the network first. `checking` is
 * that gap, and it is real enough to need its own screen — showing the sign-in
 * button during it would ask an already-signed-in user to sign in again.
 */

import type { MobileAuthSession } from "./mobile-auth";
import {
  isMobileSignInProvider,
  MicrosoftResolveError,
  MICROSOFT_RESOLVE_NETWORK,
  type MobileSignInProvider,
} from "./mobile-providers";

export type MobileSignInState =
  | "checking"
  | "signed-out"
  /** The hosted UI is open in the system browser; we are waiting on the link back. */
  | "opening"
  | "signed-in";

export interface MobileSignIn {
  /** Try the stored refresh token. Always settles on signed-in or signed-out. */
  start(): Promise<void>;
  /**
   * Hand Cognito to the system browser, opened straight at `provider`.
   * Microsoft needs the person's email to pick the right Microsoft provider.
   */
  signIn(provider: MobileSignInProvider, options?: { email?: string }): Promise<void>;
  /** Consume an `hqmobile://auth?…` deep link. */
  handleCallback(url: string): Promise<void>;
  /** Forget the session. Safe to call from a synchronous 401 handler. */
  signOut(): void;
}

export function createMobileSignIn(deps: {
  session: MobileAuthSession;
  onState: (state: MobileSignInState) => void;
  /** Look up the Cognito provider for a Microsoft email. */
  resolveMicrosoft?: (email: string) => Promise<string>;
  /** A message the sign-in screen should show, or null to clear it. */
  onError?: (message: string | null) => void;
}): MobileSignIn {
  const { session, onState } = deps;
  const onError = deps.onError ?? (() => {});

  return {
    async start() {
      onState("checking");
      try {
        onState((await session.restore()) ? "signed-in" : "signed-out");
      } catch {
        // A revoked or expired refresh token throws. The actionable answer is
        // the sign-in button, not an error screen the user cannot act on.
        onState("signed-out");
      }
    },

    async signIn(provider, options = {}) {
      if (!isMobileSignInProvider(provider)) return;
      onError(null);
      onState("opening");
      let identityProvider: string = provider;
      if (provider === "Microsoft") {
        try {
          if (!deps.resolveMicrosoft) throw new MicrosoftResolveError(MICROSOFT_RESOLVE_NETWORK);
          identityProvider = await deps.resolveMicrosoft(options.email ?? "");
        } catch (error) {
          onError(
            error instanceof MicrosoftResolveError ? error.message : MICROSOFT_RESOLVE_NETWORK,
          );
          onState("signed-out");
          return;
        }
      }
      try {
        await session.beginSignIn({ identityProvider });
      } catch {
        // The browser never opened. Staying in "opening" would strand the
        // user on a screen with nothing to tap.
        onState("signed-out");
      }
    },

    async handleCallback(url: string) {
      try {
        await session.completeSignIn(url);
        onState("signed-in");
      } catch {
        // Mismatched state, a replayed link, or a declined consent screen.
        // None of them are terminal; the user must be able to try again.
        onState("signed-out");
      }
    },

    signOut() {
      // hq-pro's 401 path calls this synchronously and does not await it.
      void session.clear();
      onState("signed-out");
    },
  };
}
