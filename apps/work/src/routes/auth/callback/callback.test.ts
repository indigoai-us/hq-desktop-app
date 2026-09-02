import { isRedirect } from "@sveltejs/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OAUTH_STATE_COOKIE,
  PKCE_VERIFIER_COOKIE,
  POST_LOGIN_REDIRECT_COOKIE,
} from "$lib/server/auth";

import { GET } from "./+server";

const KEYS = [
  "AWS_REGION",
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "COGNITO_HOSTED_UI_DOMAIN",
  "PUBLIC_APP_ORIGIN",
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

function cookies(values: Record<string, string> = {}) {
  const store = new Map(Object.entries(values));
  const deleted: string[] = [];
  return {
    deleted,
    jar: {
      get: (name: string) => store.get(name),
      delete: (name: string) => {
        store.delete(name);
        deleted.push(name);
      },
    },
  };
}

function call(path: string, jar: ReturnType<typeof cookies>["jar"]) {
  return GET({
    url: new URL(`https://work.hq.computer${path}`),
    cookies: jar,
    fetch,
  } as never);
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  configure();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("/auth/callback OAuth errors", () => {
  it("redirects a valid-state access denial to the branded sign-in error", async () => {
    const { jar } = cookies({
      [OAUTH_STATE_COOKIE]: "valid-state",
      [PKCE_VERIFIER_COOKIE]: "verifier",
      [POST_LOGIN_REDIRECT_COOKIE]: "/?dm=person-2",
    });

    try {
      await call("/auth/callback?error=access_denied&state=valid-state", jar);
      throw new Error("expected a redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) {
        expect(err.status).toBe(303);
        expect(err.location).toBe(
          "/auth/signin?error=AccessDenied&callbackUrl=%2F%3Fdm%3Dperson-2",
        );
      }
    }
  });

  it("maps other OAuth errors to OAuthCallback", async () => {
    const { jar } = cookies({
      [OAUTH_STATE_COOKIE]: "valid-state",
      [PKCE_VERIFIER_COOKIE]: "verifier",
    });

    try {
      await call("/auth/callback?error=server_error&state=valid-state", jar);
      throw new Error("expected a redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) {
        expect(err.location).toBe("/auth/signin?error=OAuthCallback");
      }
    }
  });

  it("keeps an OAuth denial with invalid state as a CSRF 400", async () => {
    const { jar } = cookies({
      [OAUTH_STATE_COOKIE]: "expected-state",
      [PKCE_VERIFIER_COOKIE]: "verifier",
    });
    const response = await call(
      "/auth/callback?error=access_denied&state=attacker-state",
      jar,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("invalid state");
  });
});
