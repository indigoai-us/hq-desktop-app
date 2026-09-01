/**
 * Web-host session cookie write/restore.
 *
 * Cookie names come from @hq/auth. The host owns httpOnly / SameSite /
 * conditional-Secure / maxAge because those depend on SvelteKit's cookie API
 * and the request protocol.
 */

import {
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  TokenExchangeError,
  refreshTokens,
  verifyIdToken,
  type AuthConfig,
  type Session,
  type TokenResponse,
} from "@hq/auth";

/** Cognito work-web refresh token validity (30 days). */
export const REFRESH_TOKEN_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export interface SessionCookieJar {
  get(name: string): string | undefined;
  set(
    name: string,
    value: string,
    opts: {
      path: string;
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      maxAge: number;
    },
  ): void;
  delete(name: string, opts: { path: string }): void;
}

export function sessionCookieOptions(secure: boolean, maxAge: number) {
  return {
    path: "/",
    httpOnly: true as const,
    secure,
    sameSite: "lax" as const,
    maxAge,
  };
}

export function writeSessionCookies(
  cookies: SessionCookieJar,
  args: {
    idToken: string;
    refreshToken?: string | null;
    session: Session;
    secure: boolean;
    now?: number;
  },
): void {
  const now = args.now ?? Date.now();
  cookies.set(
    ID_TOKEN_COOKIE,
    args.idToken,
    sessionCookieOptions(
      args.secure,
      Math.max(60, Math.floor((args.session.expiresAt - now) / 1000)),
    ),
  );
  if (args.refreshToken) {
    cookies.set(
      REFRESH_TOKEN_COOKIE,
      args.refreshToken,
      sessionCookieOptions(args.secure, REFRESH_TOKEN_MAX_AGE_SEC),
    );
  }
}

export function clearSessionCookies(cookies: SessionCookieJar): void {
  cookies.delete(ID_TOKEN_COOKIE, { path: "/" });
  cookies.delete(REFRESH_TOKEN_COOKIE, { path: "/" });
}

/**
 * Resolve a live session from the cookie jar. A still-valid id_token wins.
 * If it is missing or expired and a refresh cookie is present, exchange it
 * for a new id_token and rewrite both cookies. Failed refresh clears both
 * so the hook can treat the caller as signed out.
 */
export async function restoreSession(
  cookies: SessionCookieJar,
  opts: {
    secure: boolean;
    fetch: typeof fetch;
    config: AuthConfig;
    now?: number;
    verify?: typeof verifyIdToken;
    refresh?: typeof refreshTokens;
  },
): Promise<Session | null> {
  const now = opts.now ?? Date.now();
  const verify = opts.verify ?? verifyIdToken;
  const refresh = opts.refresh ?? refreshTokens;

  const idToken = cookies.get(ID_TOKEN_COOKIE);
  const storedRefresh = cookies.get(REFRESH_TOKEN_COOKIE);

  if (idToken) {
    const session = await verify(opts.config, idToken, { fetch: opts.fetch });
    if (session && session.expiresAt > now) return session;
  }

  if (!storedRefresh) {
    if (idToken) clearSessionCookies(cookies);
    return null;
  }

  try {
    const tokens = await refreshSerialized(storedRefresh, () =>
      refresh(opts.config, {
        refreshToken: storedRefresh,
        fetch: opts.fetch,
      }),
    );
    if (tokens.id_token) {
      const session = await verify(opts.config, tokens.id_token, {
        fetch: opts.fetch,
      });
      if (session && session.expiresAt > now) {
        writeSessionCookies(cookies, {
          idToken: tokens.id_token,
          refreshToken: tokens.refresh_token || storedRefresh,
          session,
          secure: opts.secure,
          now,
        });
        return session;
      }
    }
  } catch (err) {
    // invalid_grant (400) means the refresh token is dead. Transient
    // failures must NOT clear cookies — a parallel refresh on another
    // request can otherwise log the user out.
    if (err instanceof TokenExchangeError && err.status === 400) {
      clearSessionCookies(cookies);
    }
    return null;
  }

  return null;
}

const refreshesInFlight = new Map<string, Promise<TokenResponse>>();

function refreshSerialized(
  refreshToken: string,
  run: () => Promise<TokenResponse>,
): Promise<TokenResponse> {
  const existing = refreshesInFlight.get(refreshToken);
  if (existing) {
    return existing;
  }
  const inFlight = run();
  refreshesInFlight.set(refreshToken, inFlight);
  void inFlight
    .finally(() => {
      if (refreshesInFlight.get(refreshToken) === inFlight) {
        refreshesInFlight.delete(refreshToken);
      }
    })
    .catch(() => {});
  return inFlight;
}
