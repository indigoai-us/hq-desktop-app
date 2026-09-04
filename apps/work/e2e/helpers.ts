/**
 * E2E auth injection: mint an RS256 id_token with the committed TEST-ONLY key
 * (the preview server verifies it via COGNITO_TEST_JWKS) and install it as
 * the httpOnly session cookie.
 */

import type { BrowserContext } from "@playwright/test";
import { SignJWT, importJWK } from "jose";

import {
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_PRIVATE_JWK,
} from "./fixtures/test-jwks";

export async function mintIdToken(
  claims: { sub?: string; email?: string; name?: string } = {},
): Promise<string> {
  const key = await importJWK({ ...TEST_PRIVATE_JWK }, "RS256");
  return new SignJWT({
    email: claims.email ?? "corey@getindigo.ai",
    name: claims.name ?? "Corey Epstein",
  })
    .setProtectedHeader({ alg: "RS256", kid: TEST_PRIVATE_JWK.kid })
    .setSubject(claims.sub ?? "person-corey")
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

export async function signIn(
  context: BrowserContext,
  baseURL = "http://localhost:4173",
): Promise<void> {
  await context.addCookies([
    {
      name: "hq_id_token",
      value: await mintIdToken(),
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}
