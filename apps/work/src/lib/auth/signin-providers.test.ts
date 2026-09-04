import { describe, expect, it } from "vitest";

import {
  SIGNIN_PROVIDER_CONFIG,
  SIGNIN_PROVIDERS,
  isAllowedSignInProvider,
  isEnabledSignInProvider,
} from "./signin-providers";

describe("signin-providers map", () => {
  it("maps Google to the Cognito 'Google' identity provider and enables it", () => {
    expect(SIGNIN_PROVIDER_CONFIG.Google.identityProvider).toBe("Google");
    expect(SIGNIN_PROVIDER_CONFIG.Google.enabled).toBe(true);
  });

  it("maps Microsoft to 'MicrosoftPersonal' but leaves it disabled (not registered on the app client)", () => {
    expect(SIGNIN_PROVIDER_CONFIG.Microsoft.identityProvider).toBe(
      "MicrosoftPersonal",
    );
    expect(SIGNIN_PROVIDER_CONFIG.Microsoft.enabled).toBe(false);
  });

  it("isAllowedSignInProvider accepts only known providers", () => {
    expect(SIGNIN_PROVIDERS).toEqual(["Google", "Microsoft"]);
    expect(isAllowedSignInProvider("Google")).toBe(true);
    expect(isAllowedSignInProvider("Microsoft")).toBe(true);
    expect(isAllowedSignInProvider("Facebook")).toBe(false);
  });

  it("isEnabledSignInProvider gates on registration", () => {
    expect(isEnabledSignInProvider("Google")).toBe(true);
    expect(isEnabledSignInProvider("Microsoft")).toBe(false);
    expect(isEnabledSignInProvider("Facebook")).toBe(false);
  });
});
