/**
 * Regression test for the US-006 production bug: PUBLIC_APP_ORIGIN was read
 * from `$env/dynamic/private`, which (per SvelteKit's publicPrefix rule)
 * never contains PUBLIC_-prefixed vars — so the deployed app reported
 * "Sign-in is not configured" even with every Vercel env var set.
 *
 * The vitest env stubs mirror the prefix split (env-stub.ts /
 * env-stub-public.ts), so this test fails if appOrigin regresses to the
 * private env.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VAULT_CLIENT_ID,
  VAULT_HOSTED_UI_DOMAIN,
  WEB_DEV_APP_ORIGIN,
} from "@hq/auth";

import { authConfig, isSigninConfigured } from "./auth";

const KEYS = [
  "AWS_REGION",
  "COGNITO_USER_POOL_ID",
  "COGNITO_ISSUER",
  "COGNITO_CLIENT_ID",
  "COGNITO_HOSTED_UI_DOMAIN",
  "PUBLIC_APP_ORIGIN",
  "VERCEL",
  "VERCEL_ENV",
] as const;

let saved: Record<string, string | undefined>;

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

describe("authConfig / isSigninConfigured", () => {
  it("is configured with the production-style env set (PUBLIC_APP_ORIGIN is PUBLIC_-prefixed)", () => {
    process.env.AWS_REGION = "us-east-1";
    process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
    process.env.COGNITO_CLIENT_ID = "testclientid";
    process.env.COGNITO_HOSTED_UI_DOMAIN =
      "vault-test.auth.us-east-1.amazoncognito.com";
    process.env.PUBLIC_APP_ORIGIN = "https://work.hq.computer";

    const config = authConfig();
    expect(config.appOrigin).toBe("https://work.hq.computer");
    expect(config.clientId).toBe("testclientid");
    expect(config.issuer).toBe(
      "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL",
    );
    expect(isSigninConfigured(config)).toBe(true);
  });

  it("uses vault-client defaults locally so vite dev needs no .env", () => {
    const config = authConfig();
    expect(isSigninConfigured(config)).toBe(true);
    expect(config.clientId).toBe(VAULT_CLIENT_ID);
    expect(config.hostedUiDomain).toBe(VAULT_HOSTED_UI_DOMAIN);
    expect(config.appOrigin).toBe(WEB_DEV_APP_ORIGIN);
  });

  it("prefers the request origin over the localhost:3000 fallback", () => {
    const config = authConfig({ origin: "http://localhost:5173" });
    expect(config.appOrigin).toBe("http://localhost:5173");
    expect(isSigninConfigured(config)).toBe(true);
  });

  it("stays unconfigured on Vercel production when PUBLIC_APP_ORIGIN is missing", () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    process.env.COGNITO_CLIENT_ID = "testclientid";
    process.env.COGNITO_HOSTED_UI_DOMAIN =
      "vault-test.auth.us-east-1.amazoncognito.com";
    expect(isSigninConfigured(authConfig())).toBe(false);
  });
});
