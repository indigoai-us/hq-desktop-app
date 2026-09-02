import { describe, expect, it, vi } from "vitest";

import {
  TokenExchangeError,
  exchangeCodeForTokens,
  refreshTokens,
} from "./token.js";
import { buildLogoutUrl } from "./logout.js";
import type { AuthConfig } from "./types.js";

const config: AuthConfig = {
  clientId: "client-123",
  hostedUiDomain: "vault-test.auth.us-east-1.amazoncognito.com",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL",
  appOrigin: "https://work.hq.computer",
};

describe("exchangeCodeForTokens (injected fetch)", () => {
  it("POSTs form-encoded PKCE params to /oauth2/token and returns the tokens", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://vault-test.auth.us-east-1.amazoncognito.com/oauth2/token",
      );
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("client-123");
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("redirect_uri")).toBe(
        "https://work.hq.computer/auth/callback",
      );
      expect(body.get("code_verifier")).toBe("verifier-xyz");
      return new Response(JSON.stringify({ id_token: "the.id.token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const tokens = await exchangeCodeForTokens(config, {
      code: "auth-code",
      codeVerifier: "verifier-xyz",
      redirectUri: "https://work.hq.computer/auth/callback",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.id_token).toBe("the.id.token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws TokenExchangeError on a non-2xx response", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      exchangeCodeForTokens(config, {
        code: "x",
        codeVerifier: "y",
        redirectUri: "https://work.hq.computer/auth/callback",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });
});

describe("refreshTokens (injected fetch)", () => {
  it("POSTs grant_type=refresh_token and returns the new tokens", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://vault-test.auth.us-east-1.amazoncognito.com/oauth2/token",
      );
      expect(init?.method).toBe("POST");
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("client-123");
      expect(body.get("refresh_token")).toBe("rt-old");
      expect(body.get("code")).toBeNull();
      return new Response(
        JSON.stringify({
          id_token: "fresh.id.token",
          access_token: "fresh.access",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const tokens = await refreshTokens(config, {
      refreshToken: "rt-old",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(tokens.id_token).toBe("fresh.id.token");
    expect(tokens.refresh_token).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws TokenExchangeError when Cognito rejects the refresh", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    await expect(
      refreshTokens(config, {
        refreshToken: "rt-dead",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });
});

describe("buildLogoutUrl", () => {
  it("builds the hosted-UI logout URL with client_id + logout_uri", () => {
    const url = new URL(
      buildLogoutUrl(config, {
        returnTo: "https://work.hq.computer/auth/signin",
      }),
    );
    expect(url.host).toBe("vault-test.auth.us-east-1.amazoncognito.com");
    expect(url.pathname).toBe("/logout");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("logout_uri")).toBe(
      "https://work.hq.computer/auth/signin",
    );
  });
});
