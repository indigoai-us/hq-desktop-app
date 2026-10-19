import { describe, expect, it } from "vitest";

import { buildAuthorizeUrl } from "./authorize.js";
import type { AuthConfig } from "./types.js";

const config: AuthConfig = {
  clientId: "7milsloo2ds7fd9lvkovar4bve",
  hostedUiDomain: "vault-test.auth.us-east-1.amazoncognito.com",
  issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL",
  appOrigin: "https://work.hq.computer",
};

describe("buildAuthorizeUrl", () => {
  it("builds the Cognito authorize URL with the expected params", () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        redirectUri: "https://work.hq.computer/auth/callback",
        state: "state-abc",
        codeChallenge: "challenge-xyz",
        identityProvider: "Google",
      }),
    );
    expect(url.host).toBe("vault-test.auth.us-east-1.amazoncognito.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(
      "7milsloo2ds7fd9lvkovar4bve",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://work.hq.computer/auth/callback",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("identity_provider")).toBe("Google");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-xyz");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits identity_provider when not given and allows a custom scope", () => {
    const url = new URL(
      buildAuthorizeUrl(config, {
        redirectUri: "hq-work://app/connect/cognito-callback",
        state: "s",
        codeChallenge: "c",
        scope: "openid",
      }),
    );
    expect(url.searchParams.has("identity_provider")).toBe(false);
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "hq-work://app/connect/cognito-callback",
    );
  });
});
