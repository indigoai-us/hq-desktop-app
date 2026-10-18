import type { CompanySignInRole, CompanySignInView, SignInFailure } from "./company-signin-model.js";

export const COMPANY_OUTPOST_BOX_DETAIL_SIGNIN_SLOT = "company-outpost-box-detail-signin-slot";

const URL = "https://claude.ai/oauth/authorize?example=1";
const NOW = Date.parse("2026-10-18T20:00:00.000Z");

export interface SignInPreviewFrame {
  role: CompanySignInRole;
  view: CompanySignInView | null;
  failure: SignInFailure | null;
  codeError: string | null;
  now: number;
}

/** One fixture per card state. Screenshots and the preview page both use this. */
export function signInPreviewFrame(state: string): SignInPreviewFrame {
  const admin = { role: "admin" as const, failure: null, codeError: null, now: NOW };
  if (state === "preparing") {
    return { ...admin, view: { signedIn: false, state: "awaiting_box" } };
  }
  if (state === "signed-in") {
    return { ...admin, view: { signedIn: true, state: "signed_in", signedInAt: "2026-10-18T19:00:00.000Z" } };
  }
  if (state === "expired") {
    return {
      ...admin,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T19:50:00.000Z" },
    };
  }
  if (state === "failed") {
    return { ...admin, view: null, failure: "unreachable" };
  }
  if (state === "code-entry") {
    return {
      ...admin,
      codeError: "That sign-in code was not accepted. Copy the full code from the Claude page and try again.",
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    };
  }
  if (state === "member-signed") {
    return { role: "member", failure: null, codeError: null, now: NOW, view: { signedIn: true, state: "signed_in" } };
  }
  if (state === "member-unsigned") {
    return {
      role: "member",
      failure: null,
      codeError: null,
      now: NOW,
      view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
    };
  }
  return {
    ...admin,
    view: { signedIn: false, state: "awaiting_sign_in", loginUrl: URL, loginUrlExpiresAt: "2026-10-18T20:10:00.000Z" },
  };
}
