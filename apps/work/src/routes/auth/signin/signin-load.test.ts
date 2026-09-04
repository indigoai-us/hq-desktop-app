/**
 * Unit test for the /auth/signin load: the deep-link branch redirects to the
 * Cognito authorize URL with identity_provider set (chooser bypassed), while
 * the no-idp / disabled-idp / unconfigured cases render the branded page.
 *
 * No server or browser — the load is called directly with a stub event. The
 * env split mirrors auth-config.test.ts (PUBLIC_ vars are public-only).
 */
import { isRedirect } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { load } from "./+page.server";

const KEYS = [
  "AWS_REGION",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_HOSTED_UI_DOMAIN",
  "PUBLIC_APP_ORIGIN",
  "VERCEL",
  "VERCEL_ENV",
] as const;

let saved: Record<string, string | undefined>;

function configure(): void {
  process.env.AWS_REGION = "us-east-1";
  process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
  process.env.COGNITO_CLIENT_ID = "7milsloo2ds7fd9lvkovar4bve";
  process.env.COGNITO_HOSTED_UI_DOMAIN =
    "vault-test.auth.us-east-1.amazoncognito.com";
  process.env.PUBLIC_APP_ORIGIN = "https://work.hq.computer";
}

interface CookieCall {
  name: string;
  value?: string;
  opts?: { secure?: boolean };
}

function makeCookies() {
  const set: CookieCall[] = [];
  const deleted: CookieCall[] = [];
  return {
    set,
    deleted,
    jar: {
      get: () => undefined,
      set: (name: string, value: string, opts?: { secure?: boolean }) =>
        set.push({ name, value, opts }),
      delete: (name: string) => deleted.push({ name }),
    },
  };
}

// The load only touches event.url and event.cookies. `origin` lets a test pick
// the request protocol (https prod vs http://localhost dev) so we can assert
// the Secure flag is protocol-conditional.
function call(
  pathAndQuery: string,
  cookies: ReturnType<typeof makeCookies>,
  origin = "https://work.hq.computer",
) {
  return load({
    url: new URL(`${origin}${pathAndQuery}`),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cookies: cookies.jar as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("/auth/signin load", () => {
  it("deep-links ?idp=Google straight to Cognito with identity_provider=Google", async () => {
    configure();
    const cookies = makeCookies();
    try {
      await call("/auth/signin?idp=Google&callbackUrl=/projects", cookies);
      throw new Error("expected a redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      const redirect = err as { status: number; location: string };
      expect(redirect.status).toBe(302);
      const loc = new URL(redirect.location);
      expect(loc.host).toBe("vault-test.auth.us-east-1.amazoncognito.com");
      expect(loc.pathname).toBe("/oauth2/authorize");
      expect(loc.searchParams.get("identity_provider")).toBe("Google");
      expect(loc.searchParams.get("response_type")).toBe("code");
      expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
      expect(loc.searchParams.get("client_id")).toBe(
        "7milsloo2ds7fd9lvkovar4bve",
      );
    }
    // PKCE verifier, CSRF state, and the safe return destination were parked.
    const names = cookies.set.map((c) => c.name);
    expect(names).toContain("hq_pkce_verifier");
    expect(names).toContain("hq_oauth_state");
    expect(
      cookies.set.find((c) => c.name === "hq_post_login_redirect")?.value,
    ).toBe("/projects");
    // Over https every transient cookie is Secure.
    for (const c of cookies.set) expect(c.opts?.secure).toBe(true);
  });

  it("sets transient cookies WITHOUT Secure over http://localhost (dev)", async () => {
    configure();
    const cookies = makeCookies();
    try {
      await call(
        "/auth/signin?idp=Google&callbackUrl=/projects",
        cookies,
        "http://localhost:3000",
      );
      throw new Error("expected a redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
    }
    // Same cookies are parked, but Secure is dropped so http://localhost keeps
    // them instead of the browser silently discarding a Secure cookie.
    const names = cookies.set.map((c) => c.name);
    expect(names).toContain("hq_pkce_verifier");
    expect(names).toContain("hq_oauth_state");
    expect(names).toContain("hq_post_login_redirect");
    for (const c of cookies.set) expect(c.opts?.secure).toBe(false);
  });

  it("renders the branded page (no redirect) when no idp is given", async () => {
    configure();
    const cookies = makeCookies();
    const data = await call("/auth/signin", cookies);
    expect(data).toBeTruthy();
    expect(data!.configured).toBe(true);
    expect(data!.callbackUrl).toBe("/");
    type Provider = { id: string; label: string; enabled: boolean };
    const providers = data!.providers as Provider[];
    const google = providers.find((p) => p.id === "Google");
    const microsoft = providers.find((p) => p.id === "Microsoft");
    expect(google?.enabled).toBe(true);
    expect(microsoft?.enabled).toBe(false);
    expect(cookies.set).toHaveLength(0);
  });

  it("does not deep-link a disabled provider (Microsoft) — renders the page instead", async () => {
    configure();
    const cookies = makeCookies();
    const data = await call("/auth/signin?idp=Microsoft", cookies);
    expect(data).toBeTruthy();
    expect(cookies.set).toHaveLength(0);
  });

  it("deep-links locally with zero env (vault-client defaults)", async () => {
    const cookies = makeCookies();
    try {
      await call("/auth/signin?idp=Google", cookies, "http://localhost:3000");
      throw new Error("expected a redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      const loc = new URL((err as { location: string }).location);
      expect(loc.host).toBe(
        "vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com",
      );
      expect(loc.searchParams.get("identity_provider")).toBe("Google");
      expect(loc.searchParams.get("redirect_uri")).toBe(
        "http://localhost:3000/auth/callback",
      );
    }
  });

  it("renders (no redirect) when Vercel production has no hosted UI env", async () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    const cookies = makeCookies();
    const data = await call("/auth/signin?idp=Google", cookies);
    expect(data).toBeTruthy();
    expect(data!.configured).toBe(false);
    expect(cookies.set).toHaveLength(0);
  });
});
