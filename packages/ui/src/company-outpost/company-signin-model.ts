/**
 * Company Outpost Claude sign-in, as the desktop card shows it.
 *
 * The person route is POST /outpost/company/signin with action status, code,
 * or regenerate. regenerate removes the current link on the server. Members
 * do not get that route, so the card never shows them a link or a code.
 */

export type CompanySignInRole = "owner" | "admin" | "member";

export type CompanySignInState =
  | "no_host"
  | "awaiting_box"
  | "awaiting_sign_in"
  | "signed_in"
  | "unknown";

export interface CompanySignInView {
  signedIn: boolean;
  state: CompanySignInState;
  loginUrl?: string;
  /** When the server says the current link stops working (ISO). */
  loginUrlExpiresAt?: string;
  signedInAt?: string;
}

export type SignInFailure =
  | "rejected"
  | "unreachable"
  | "not_admin"
  | "unavailable"
  | "not_ready"
  | "link_changed"
  | "not_available";

/** Where "Contact us" goes when Outposts are not available for the company yet. */
export const SIGNIN_CONTACT_URL = "https://hqforwork.com/book";

export const SIGNIN_COPY = {
  title: "Claude sign-in",
  notSignedIn: "Not signed in to Claude. Company jobs will not run until an owner or admin signs this box in.",
  memberNotSignedIn: "Not signed in to Claude.",
  memberSignedIn: "Signed in to Claude.",
  signedIn: "Signed in to Claude. Company jobs run on this sign-in.",
  preparing: "The box is preparing a sign-in link. Refresh in a few seconds.",
  notReady: "Sign-in opens on this card when the Outpost is ready.",
  openLink: "Open the Claude sign-in page",
  openRest: "and sign in with the account company jobs should use.",
  paste: "Paste the code it shows below.",
  codeLabel: "Code",
  submit: "Submit code",
  submitting: "Submitting...",
  refresh: "Refresh",
  newLink: "New sign-in link",
  rejected: "That sign-in code was not accepted. Copy the full code from the Claude page and try again.",
  finishing: "Finishing sign-in...",
  linkChanged: "The sign-in link changed. Use the new link below.",
  unreachable: "Could not reach the company Outpost. Try again.",
  notAdmin: "Only company owners and admins can do this.",
  unavailable: "Sign-in status is not available yet.",
  notAvailable: "Outposts are not available for this company yet.",
  contact: "Contact us",
  expired: "This sign-in link has expired. Request a new sign-in link to try again.",
  expiresAbout: "This link expires about 10 minutes after the Outpost creates it.",
  badgeNot: "Not signed in",
  badgeSigned: "Signed in",
  badgeWaiting: "Waiting",
  badgeUnavailable: "Unavailable",
} as const;

const STATES: readonly CompanySignInState[] = ["no_host", "awaiting_box", "awaiting_sign_in", "signed_in"];
const LOGIN_HOSTS = ["claude.ai", "claude.com", "anthropic.com"];
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A Claude sign-in link safe to open: https, a Claude host, the authorize path. */
export function safeCompanyLoginUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  if ([...value].some((ch) => ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  const allowed = LOGIN_HOSTS.some((name) => host === name || host.endsWith(`.${name}`));
  if (!allowed || !url.pathname.endsWith("/oauth/authorize")) return undefined;
  return url.href;
}

function instant(value: unknown): string | undefined {
  return typeof value === "string" && ISO_INSTANT.test(value) ? value : undefined;
}

/** Map a status response body. Unfamiliar shapes become unknown, with no link. */
export function parseCompanySignInBody(body: unknown): CompanySignInView {
  const raw = body && typeof body === "object" ? (body as { signIn?: unknown }).signIn : undefined;
  if (!raw || typeof raw !== "object") return { signedIn: false, state: "unknown" };
  const row = raw as Record<string, unknown>;
  const state = typeof row.state === "string" && STATES.includes(row.state as CompanySignInState)
    ? (row.state as CompanySignInState)
    : "unknown";
  const loginUrl = safeCompanyLoginUrl(row.loginUrl);
  const loginUrlExpiresAt = instant(row.loginUrlExpiresAt);
  const signedInAt = instant(row.signedInAt);
  return {
    signedIn: row.signedIn === true && state === "signed_in",
    state,
    ...(loginUrl ? { loginUrl } : {}),
    ...(loginUrlExpiresAt ? { loginUrlExpiresAt } : {}),
    ...(signedInAt ? { signedInAt } : {}),
  };
}

export function linkExpiryLine(expiresAt: string | undefined, now: number): { expired: boolean; text: string } {
  if (!expiresAt) return { expired: false, text: SIGNIN_COPY.expiresAbout };
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return { expired: false, text: SIGNIN_COPY.expiresAbout };
  if (at <= now) return { expired: true, text: SIGNIN_COPY.expired };
  const when = new Date(at);
  const hh = String(when.getUTCHours()).padStart(2, "0");
  const mm = String(when.getUTCMinutes()).padStart(2, "0");
  return { expired: false, text: `This link expires at ${hh}:${mm} UTC.` };
}

export type SignInPhase =
  | "loading"
  | "failed"
  | "not_available"
  | "unavailable"
  | "preparing"
  | "expired"
  | "awaiting_code"
  | "code_rejected"
  | "signed_in";

export interface SignInPresentation {
  phase: SignInPhase;
  headline: string;
  detail: string | null;
  expiry: string | null;
  codeError: string | null;
  showLink: boolean;
  showCode: boolean;
  showRefresh: boolean;
  showNewLink: boolean;
  showContact: boolean;
  badge: string;
  loginUrl?: string;
}

function manage(role: CompanySignInRole): boolean {
  return role === "owner" || role === "admin";
}

export function deriveSignInPresentation(input: {
  role: CompanySignInRole;
  view: CompanySignInView | null;
  failure: SignInFailure | null;
  codeError: string | null;
  now: number;
}): SignInPresentation {
  const canManage = manage(input.role);
  const blank = (phase: SignInPhase, headline: string, detail: string | null, badge: string): SignInPresentation => ({
    phase,
    headline,
    detail,
    expiry: null,
    codeError: null,
    showLink: false,
    showCode: false,
    showRefresh: canManage && phase !== "loading" && phase !== "signed_in",
    showNewLink: false,
    showContact: false,
    badge,
  });

  if (input.failure === "not_available") {
    return { ...blank("not_available", SIGNIN_COPY.notAvailable, null, SIGNIN_COPY.badgeUnavailable), showRefresh: false, showContact: true };
  }

  if (!canManage) {
    const view = input.view;
    if (!view || view.state === "unknown") {
      return blank("unavailable", SIGNIN_COPY.unavailable, null, SIGNIN_COPY.badgeUnavailable);
    }
    if (view.signedIn && view.state === "signed_in") {
      return blank("signed_in", SIGNIN_COPY.memberSignedIn, null, SIGNIN_COPY.badgeSigned);
    }
    return blank("preparing", SIGNIN_COPY.memberNotSignedIn, null, SIGNIN_COPY.badgeNot);
  }

  if (!input.view && input.failure === "unreachable") {
    return {
      ...blank("failed", SIGNIN_COPY.notSignedIn, SIGNIN_COPY.unreachable, SIGNIN_COPY.badgeUnavailable),
      showRefresh: true,
    };
  }
  if (!input.view) {
    if (input.failure) return blank("unavailable", SIGNIN_COPY.unavailable, null, SIGNIN_COPY.badgeUnavailable);
    return blank("loading", SIGNIN_COPY.unavailable, null, SIGNIN_COPY.badgeWaiting);
  }

  const view = input.view;
  if (view.state === "signed_in" && view.signedIn) {
    return blank("signed_in", SIGNIN_COPY.signedIn, null, SIGNIN_COPY.badgeSigned);
  }
  if (view.state === "unknown") {
    return blank("unavailable", SIGNIN_COPY.unavailable, null, SIGNIN_COPY.badgeUnavailable);
  }
  if (view.state === "no_host") {
    return {
      ...blank("preparing", SIGNIN_COPY.notSignedIn, SIGNIN_COPY.notReady, SIGNIN_COPY.badgeWaiting),
      showRefresh: true,
      showNewLink: true,
    };
  }

  const expiry = view.loginUrl ? linkExpiryLine(view.loginUrlExpiresAt, input.now) : null;
  if (view.loginUrl && expiry?.expired) {
    return {
      ...blank("expired", SIGNIN_COPY.notSignedIn, SIGNIN_COPY.expired, SIGNIN_COPY.badgeNot),
      showRefresh: true,
      showNewLink: true,
    };
  }
  if (view.loginUrl && expiry) {
    const rejected = Boolean(input.codeError);
    return {
      phase: rejected ? "code_rejected" : "awaiting_code",
      headline: SIGNIN_COPY.notSignedIn,
      detail: null,
      expiry: expiry.text,
      codeError: input.codeError,
      showLink: true,
      showCode: true,
      showRefresh: true,
      showNewLink: true,
      showContact: false,
      badge: SIGNIN_COPY.badgeNot,
      loginUrl: view.loginUrl,
    };
  }

  return {
    ...blank("preparing", SIGNIN_COPY.notSignedIn, SIGNIN_COPY.preparing, SIGNIN_COPY.badgeWaiting),
    showRefresh: true,
    showNewLink: true,
  };
}

/**
 * Status keeps the previous loginUrl until the box posts a new one.
 * Hide that address so the card stays on Preparing.
 */
export function suppressUnchangedLink(previousUrl: string | null, next: CompanySignInView): CompanySignInView {
  if (!previousUrl || next.signedIn || next.loginUrl !== previousUrl) return next;
  return { signedIn: next.signedIn, state: next.state, signedInAt: next.signedInAt };
}

/** Contract poll intervals. Null means the card is idle. */
export function signInPollDelayMs(view: CompanySignInView | null, finishing: boolean): number | null {
  if (finishing) return 3_000;
  if (!view || view.state === "signed_in" || view.state === "unknown") return null;
  if (view.state === "awaiting_box" || (view.state === "awaiting_sign_in" && !view.loginUrl)) return 5_000;
  if (view.loginUrl) return 15_000;
  if (view.state === "no_host") return 5_000;
  return null;
}
