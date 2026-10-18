import { describe, expect, it } from "vitest";
import {
  SIGNIN_COPY,
  deriveSignInPresentation,
  linkExpiryLine,
  parseCompanySignInBody,
  safeCompanyLoginUrl,
  signInPollDelayMs,
  suppressUnchangedLink,
} from "./company-signin-model.js";

const NOW = Date.parse("2026-10-18T20:00:00.000Z");
const URL = "https://claude.ai/oauth/authorize?example=1";
const LATER = "2026-10-18T20:10:00.000Z";
const EARLIER = "2026-10-18T19:50:00.000Z";

describe("company sign-in view", () => {
  it("reads the status payload and keeps an optional expiry", () => {
    expect(parseCompanySignInBody({
      signIn: {
        signedIn: false,
        state: "awaiting_sign_in",
        loginUrl: URL,
        loginUrlExpiresAt: LATER,
      },
    })).toEqual({
      signedIn: false,
      state: "awaiting_sign_in",
      loginUrl: URL,
      loginUrlExpiresAt: LATER,
    });
  });

  it("drops a sign-in link that is not a Claude https address", () => {
    expect(safeCompanyLoginUrl("http://claude.ai/oauth/authorize")).toBeUndefined();
    expect(safeCompanyLoginUrl("https://evil.example/oauth/authorize")).toBeUndefined();
    expect(parseCompanySignInBody({
      signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: "https://evil.example/oauth/authorize" },
    }).loginUrl).toBeUndefined();
  });

  it("treats a missing or unfamiliar payload as unknown", () => {
    expect(parseCompanySignInBody(null)).toEqual({ signedIn: false, state: "unknown" });
    expect(parseCompanySignInBody({ signIn: { state: "elsewhere", signedIn: true } })).toEqual({
      signedIn: false,
      state: "unknown",
    });
  });
});

describe("link expiry", () => {
  it("names the clock time when the server sent one", () => {
    expect(linkExpiryLine(LATER, NOW)).toEqual({
      expired: false,
      text: "This link expires at 20:10 UTC.",
    });
  });

  it("says the link has expired once that time has passed", () => {
    expect(linkExpiryLine(EARLIER, NOW)).toEqual({
      expired: true,
      text: SIGNIN_COPY.expired,
    });
  });

  it("says about 10 minutes when the server did not send a time", () => {
    expect(linkExpiryLine(undefined, NOW)).toEqual({
      expired: false,
      text: SIGNIN_COPY.expiresAbout,
    });
  });
});

describe("sign-in card presentation", () => {
  const admin = { role: "admin" as const, failure: null, codeError: null, now: NOW };

  it("shows the not-signed-in card waiting for a code", () => {
    const view = parseCompanySignInBody({
      signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: LATER },
    });
    const card = deriveSignInPresentation({ ...admin, view });
    expect(card.phase).toBe("awaiting_code");
    expect(card.headline).toBe(SIGNIN_COPY.notSignedIn);
    expect(card.showLink).toBe(true);
    expect(card.showCode).toBe(true);
    expect(card.showNewLink).toBe(true);
    expect(card.expiry).toBe("This link expires at 20:10 UTC.");
    expect(card.loginUrl).toBe(URL);
  });

  it("shows preparing when the box has no link yet", () => {
    const view = parseCompanySignInBody({ signIn: { signedIn: false, state: "awaiting_box" } });
    const card = deriveSignInPresentation({ ...admin, view });
    expect(card.phase).toBe("preparing");
    expect(card.headline).toBe(SIGNIN_COPY.notSignedIn);
    expect(card.detail).toBe(SIGNIN_COPY.preparing);
    expect(card.showCode).toBe(false);
    expect(card.showLink).toBe(false);
    expect(card.showNewLink).toBe(true);
  });

  it("shows preparing while a link is being minted", () => {
    const view = parseCompanySignInBody({ signIn: { signedIn: false, state: "awaiting_sign_in" } });
    expect(deriveSignInPresentation({ ...admin, view }).phase).toBe("preparing");
  });

  it("shows the expired link without offering the old address", () => {
    const view = parseCompanySignInBody({
      signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: EARLIER },
    });
    const card = deriveSignInPresentation({ ...admin, view });
    expect(card.phase).toBe("expired");
    expect(card.detail).toBe(SIGNIN_COPY.expired);
    expect(card.showLink).toBe(false);
    expect(card.loginUrl).toBeUndefined();
    expect(card.showNewLink).toBe(true);
    expect(card.showCode).toBe(false);
  });

  it("shows signed in with no code field", () => {
    const view = parseCompanySignInBody({
      signIn: { signedIn: true, state: "signed_in", signedInAt: "2026-10-18T19:00:00.000Z" },
    });
    const card = deriveSignInPresentation({ ...admin, view });
    expect(card.phase).toBe("signed_in");
    expect(card.headline).toBe(SIGNIN_COPY.signedIn);
    expect(card.showCode).toBe(false);
    expect(card.showNewLink).toBe(false);
    expect(card.showLink).toBe(false);
  });

  it("shows a failed read as one plain line", () => {
    const card = deriveSignInPresentation({ ...admin, view: null, failure: "unreachable" });
    expect(card.phase).toBe("failed");
    expect(card.detail).toBe(SIGNIN_COPY.unreachable);
    expect(card.showRefresh).toBe(true);
    expect(card.showCode).toBe(false);
  });

  it("shows an unknown status with refresh only", () => {
    const view = parseCompanySignInBody({ signIn: { signedIn: false, state: "unknown" } });
    const card = deriveSignInPresentation({ ...admin, view });
    expect(card.phase).toBe("unavailable");
    expect(card.headline).toBe(SIGNIN_COPY.unavailable);
    expect(card.showRefresh).toBe(true);
    expect(card.showNewLink).toBe(false);
    expect(card.showCode).toBe(false);
  });

  it("keeps a code rejection on the waiting card", () => {
    const view = parseCompanySignInBody({
      signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: LATER },
    });
    const card = deriveSignInPresentation({ ...admin, view, codeError: SIGNIN_COPY.rejected });
    expect(card.phase).toBe("code_rejected");
    expect(card.codeError).toBe(SIGNIN_COPY.rejected);
    expect(card.showCode).toBe(true);
  });

  it("shows members the state and none of the manage actions", () => {
    const signed = deriveSignInPresentation({
      role: "member",
      failure: null,
      codeError: null,
      now: NOW,
      view: parseCompanySignInBody({ signIn: { signedIn: true, state: "signed_in", loginUrl: URL } }),
    });
    expect(signed.headline).toBe(SIGNIN_COPY.memberSignedIn);
    expect(signed.showLink).toBe(false);
    expect(signed.showCode).toBe(false);
    expect(signed.showNewLink).toBe(false);
    expect(signed.showRefresh).toBe(false);
    expect(signed.loginUrl).toBeUndefined();

    const waiting = deriveSignInPresentation({
      role: "member",
      failure: null,
      codeError: SIGNIN_COPY.rejected,
      now: NOW,
      view: parseCompanySignInBody({
        signIn: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: LATER },
      }),
    });
    expect(waiting.headline).toBe(SIGNIN_COPY.memberNotSignedIn);
    expect(waiting.showCode).toBe(false);
    expect(waiting.codeError).toBeNull();
    expect(waiting.loginUrl).toBeUndefined();
  });
});

describe("sign-in route timing", () => {
  it("hides a link the server has not replaced yet", () => {
    const next = suppressUnchangedLink(URL, {
      signedIn: false,
      state: "awaiting_sign_in",
      loginUrl: URL,
      loginUrlExpiresAt: LATER,
    });
    expect(next.loginUrl).toBeUndefined();
    expect(suppressUnchangedLink(URL, {
      signedIn: false,
      state: "awaiting_sign_in",
      loginUrl: "https://claude.ai/oauth/authorize?example=2",
    }).loginUrl).toBe("https://claude.ai/oauth/authorize?example=2");
  });

  it("polls on the contract intervals", () => {
    expect(signInPollDelayMs({ signedIn: false, state: "awaiting_box" }, false)).toBe(5_000);
    expect(signInPollDelayMs({ signedIn: false, state: "awaiting_sign_in" }, false)).toBe(5_000);
    expect(signInPollDelayMs({ signedIn: false, state: "awaiting_sign_in", loginUrl: URL }, false)).toBe(15_000);
    expect(signInPollDelayMs({ signedIn: false, state: "awaiting_sign_in", loginUrl: URL }, true)).toBe(3_000);
    expect(signInPollDelayMs({ signedIn: true, state: "signed_in" }, false)).toBeNull();
  });
});
