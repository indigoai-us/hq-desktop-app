import { describe, expect, it, vi } from "vitest";

import type { MobileAuthSession } from "./mobile-auth";
import {
  MICROSOFT_EMAIL_INVALID,
  MICROSOFT_RESOLVE_NETWORK,
  MicrosoftResolveError,
} from "./mobile-providers";
import { createMobileSignIn, type MobileSignInState } from "./mobile-sign-in";

/**
 * The state a phone's shell renders from.
 *
 * The web app answers "am I signed in?" with a same-origin session read before
 * the page renders. A phone cannot: it has to try its stored refresh token
 * first, and that is a network round trip. So the shell has a real third state
 * between signed-in and signed-out, and the flow below is what drives it.
 */

function fakeSession(overrides: Partial<MobileAuthSession> = {}) {
  return {
    beginSignIn: vi.fn(async () => {}),
    completeSignIn: vi.fn(async () => {}),
    restore: vi.fn(async () => false),
    getToken: vi.fn(async () => null),
    clear: vi.fn(async () => {}),
    ...overrides,
  } satisfies MobileAuthSession;
}

function harness(session: MobileAuthSession) {
  const states: MobileSignInState[] = [];
  const signIn = createMobileSignIn({
    session,
    onState: (state) => states.push(state),
  });
  return { signIn, states };
}

describe("mobile sign-in state", () => {
  it("starts by trying the stored refresh token", async () => {
    const session = fakeSession({ restore: vi.fn(async () => true) });
    const { signIn, states } = harness(session);

    await signIn.start();

    expect(session.restore).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["checking", "signed-in"]);
  });

  it("lands signed-out when there is nothing stored", async () => {
    const { signIn, states } = harness(fakeSession());
    await signIn.start();
    expect(states).toEqual(["checking", "signed-out"]);
  });

  it("treats a refresh failure as signed-out, not as an error screen", async () => {
    // A revoked or expired refresh token throws. The right answer is the
    // sign-in button, not a dead end the user cannot act on.
    const session = fakeSession({
      restore: vi.fn(async () => {
        throw new Error("invalid_grant");
      }),
    });
    const { signIn, states } = harness(session);

    await signIn.start();

    expect(states).toEqual(["checking", "signed-out"]);
  });

  it("hands the browser the hosted UI and waits", async () => {
    const session = fakeSession();
    const { signIn, states } = harness(session);
    await signIn.start();
    states.length = 0;

    await signIn.signIn("Google");

    expect(session.beginSignIn).toHaveBeenCalledExactlyOnceWith({ identityProvider: "Google" });
    // "opening" is what stops a second tap from starting a second flow, which
    // would replace the PKCE material the first callback needs.
    expect(states).toEqual(["opening"]);
  });

  it("returns to signed-out if the browser never opens", async () => {
    const session = fakeSession({
      beginSignIn: vi.fn(async () => {
        throw new Error("no opener");
      }),
    });
    const { signIn, states } = harness(session);
    await signIn.start();
    states.length = 0;

    await signIn.signIn("Google");

    expect(states).toEqual(["opening", "signed-out"]);
  });

  it("completes on the deep-link callback", async () => {
    const session = fakeSession();
    const { signIn, states } = harness(session);
    await signIn.start();
    await signIn.signIn("Google");
    states.length = 0;

    await signIn.handleCallback("hqmobile://auth?code=CODE-1&state=STATE-1");

    expect(session.completeSignIn).toHaveBeenCalledWith(
      "hqmobile://auth?code=CODE-1&state=STATE-1",
    );
    expect(states).toEqual(["signed-in"]);
  });

  it("stays signed-out when the callback is rejected", async () => {
    // A mismatched state, a replayed link, or a denied consent screen. The
    // user must be able to try again, so this is not terminal.
    const session = fakeSession({
      completeSignIn: vi.fn(async () => {
        throw new Error("state mismatch");
      }),
    });
    const { signIn, states } = harness(session);
    await signIn.start();
    await signIn.signIn("Google");
    states.length = 0;

    await signIn.handleCallback("hqmobile://auth?code=x&state=forged");

    expect(states).toEqual(["signed-out"]);
  });

  it("drops the session when hq-pro rejects the token", async () => {
    const session = fakeSession({ restore: vi.fn(async () => true) });
    const { signIn, states } = harness(session);
    await signIn.start();
    states.length = 0;

    signIn.signOut();
    await vi.waitFor(() => expect(session.clear).toHaveBeenCalledTimes(1));
    expect(states).toEqual(["signed-out"]);
  });
});

it("does not open an unregistered provider", async () => {
  const session = fakeSession();
  const onState = vi.fn();
  const flow = createMobileSignIn({ session, onState });
  await flow.signIn("Facebook" as never);
  expect(session.beginSignIn).not.toHaveBeenCalled();
  expect(onState).not.toHaveBeenCalled();
});

describe("Microsoft on a phone", () => {
  const WORK_PROVIDER = "MsOrg87489d4600af47338b7bafe9bd";

  it("asks hq-pro which provider owns the email, then opens Cognito at it", async () => {
    const session = fakeSession();
    const states: MobileSignInState[] = [];
    const errors: (string | null)[] = [];
    const resolveMicrosoft = vi.fn(async () => WORK_PROVIDER);
    const flow = createMobileSignIn({
      session,
      onState: (state) => states.push(state),
      onError: (message) => errors.push(message),
      resolveMicrosoft,
    });

    await flow.signIn("Microsoft", { email: "person@contoso.example" });

    expect(resolveMicrosoft).toHaveBeenCalledExactlyOnceWith("person@contoso.example");
    expect(session.beginSignIn).toHaveBeenCalledExactlyOnceWith({
      identityProvider: WORK_PROVIDER,
    });
    expect(states).toEqual(["opening"]);
    expect(errors).toEqual([null]);
  });

  it("shows the resolve error and never opens the browser when resolve fails", async () => {
    const session = fakeSession();
    const states: MobileSignInState[] = [];
    const errors: (string | null)[] = [];
    const flow = createMobileSignIn({
      session,
      onState: (state) => states.push(state),
      onError: (message) => errors.push(message),
      resolveMicrosoft: vi.fn(async () => {
        throw new MicrosoftResolveError(MICROSOFT_EMAIL_INVALID);
      }),
    });

    await flow.signIn("Microsoft", { email: "not-an-email" });

    expect(session.beginSignIn).not.toHaveBeenCalled();
    expect(states).toEqual(["opening", "signed-out"]);
    expect(errors).toEqual([null, MICROSOFT_EMAIL_INVALID]);
  });

  it("does not leak an unexpected error's text to the screen", async () => {
    const session = fakeSession();
    const errors: (string | null)[] = [];
    const flow = createMobileSignIn({
      session,
      onState: () => {},
      onError: (message) => errors.push(message),
      resolveMicrosoft: vi.fn(async () => {
        throw new Error("internal detail");
      }),
    });

    await flow.signIn("Microsoft", { email: "person@contoso.example" });

    expect(session.beginSignIn).not.toHaveBeenCalled();
    expect(errors).toEqual([null, MICROSOFT_RESOLVE_NETWORK]);
  });
});
