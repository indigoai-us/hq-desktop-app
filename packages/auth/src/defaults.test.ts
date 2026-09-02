import { describe, expect, it } from "vitest";

import {
  VAULT_CLIENT_ID,
  VAULT_HOSTED_UI_DOMAIN,
  VAULT_USER_POOL_ID,
  WEB_DEV_APP_ORIGIN,
  vaultIssuer,
} from "./defaults.js";

describe("vault-client defaults", () => {
  it("exports the public vault-client identifiers used by desktop + local web", () => {
    expect(VAULT_CLIENT_ID).toMatch(/^[a-z0-9]+$/);
    expect(VAULT_USER_POOL_ID).toMatch(/^us-east-1_/);
    expect(VAULT_HOSTED_UI_DOMAIN).toContain("amazoncognito.com");
    expect(WEB_DEV_APP_ORIGIN).toBe("http://localhost:3000");
    expect(vaultIssuer()).toBe(
      `https://cognito-idp.us-east-1.amazonaws.com/${VAULT_USER_POOL_ID}`,
    );
  });
});
