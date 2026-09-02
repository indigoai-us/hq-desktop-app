import { describe, expect, it } from "vitest";

import { isSigninConfigured } from "./config.js";
import {
  SIGNIN_PROVIDER_CONFIG,
  SIGNIN_PROVIDERS,
  isAllowedSignInProvider,
  isEnabledSignInProvider,
} from "./providers.js";
import type { AuthConfig } from "./types.js";

describe("signin-providers map", () => {
  it("maps Google to the Cognito 'Google' identity provider and enables it", () => {
    expect(SIGNIN_PROVIDER_CONFIG.Google.identityProvider).toBe("Google");
    expect(SIGNIN_PROVIDER_CONFIG.Google.enabled).toBe(true);
  });

  it("maps Microsoft to 'MicrosoftPersonal' but leaves it disabled", () => {
    expect(SIGNIN_PROVIDER_CONFIG.Microsoft.identityProvider).toBe(
      "MicrosoftPersonal",
    );
    expect(SIGNIN_PROVIDER_CONFIG.Microsoft.enabled).toBe(false);
  });

  it("isAllowedSignInProvider accepts only known providers", () => {
    expect(SIGNIN_PROVIDERS).toEqual(["Google", "Microsoft"]);
    expect(isAllowedSignInProvider("Google")).toBe(true);
    expect(isAllowedSignInProvider("Facebook")).toBe(false);
  });

  it("isEnabledSignInProvider gates on registration", () => {
    expect(isEnabledSignInProvider("Google")).toBe(true);
    expect(isEnabledSignInProvider("Microsoft")).toBe(false);
    expect(isEnabledSignInProvider("Facebook")).toBe(false);
  });
});

describe("isSigninConfigured", () => {
  const base: AuthConfig = {
    clientId: "c",
    hostedUiDomain: "d.auth.amazoncognito.com",
    issuer: "https://issuer",
    appOrigin: "https://work.hq.computer",
  };
  it("is true only with domain, clientId, issuer, and appOrigin", () => {
    expect(isSigninConfigured(base)).toBe(true);
    expect(isSigninConfigured({ ...base, appOrigin: "" })).toBe(false);
    expect(isSigninConfigured({ ...base, hostedUiDomain: "" })).toBe(false);
    expect(isSigninConfigured({ ...base, clientId: "" })).toBe(false);
    expect(isSigninConfigured({ ...base, issuer: "" })).toBe(false);
  });
});
