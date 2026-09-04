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

export type MobileSignInState =
  | "checking"
  | "signed-out"
  /** The hosted UI is open in the system browser; we are waiting on the link back. */
  | "opening"
  | "signed-in";

export interface MobileSignIn {
  /** Try the stored refresh token. Always settles on signed-in or signed-out. */
  start(): Promise<void>;
  /** Hand the Cognito hosted UI to the system browser. */
  signIn(): Promise<void>;
  /** Consume an `hqmobile://auth?…` deep link. */
  handleCallback(url: string): Promise<void>;
  /** Forget the session. Safe to call from a synchronous 401 handler. */
  signOut(): void;
}

export function createMobileSignIn(deps: {
  session: MobileAuthSession;
  onState: (state: MobileSignInState) => void;
}): MobileSignIn {
  const { session, onState } = deps;

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

    async signIn() {
      onState("opening");
      try {
        await session.beginSignIn();
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
