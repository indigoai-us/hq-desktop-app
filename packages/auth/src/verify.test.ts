import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import { describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "./types.js";
import { verifyIdToken } from "./verify.js";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL";
const CLIENT_ID = "client-123";

// Mint an RS256 id_token + expose its public key as a local JWKS, exactly the
// shape the host adapter would inject as config.testJwks in CI/E2E.
async function mintSession(claims: Record<string, unknown>, expOffset = 3600) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt(now)
    .setExpirationTime(now + expOffset)
    .sign(privateKey);
  return { token, jwks };
}

function config(testJwks?: JSONWebKeySet): AuthConfig {
  return {
    clientId: CLIENT_ID,
    hostedUiDomain: "vault-test.auth.us-east-1.amazoncognito.com",
    issuer: ISSUER,
    appOrigin: "https://work.hq.computer",
    testJwks,
  };
}

describe("verifyIdToken (data-driven test-JWKS seam)", () => {
  it("verifies a valid token against the injected testJwks and distills the session", async () => {
    const { token, jwks } = await mintSession({
      sub: "user-abc",
      email: "person@example.com",
      name: "Person Example",
    });
    const session = await verifyIdToken(config(jwks), token);
    expect(session).not.toBeNull();
    expect(session!.sub).toBe("user-abc");
    expect(session!.email).toBe("person@example.com");
    expect(session!.name).toBe("Person Example");
    expect(session!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("nulls email and name when the claims are absent", async () => {
    const { token, jwks } = await mintSession({ sub: "user-noemail" });
    const session = await verifyIdToken(config(jwks), token);
    expect(session!.email).toBeNull();
    expect(session!.name).toBeNull();
  });

  it("returns null on audience mismatch", async () => {
    const { token, jwks } = await mintSession({ sub: "u" });
    const bad = { ...config(jwks), clientId: "wrong-audience" };
    expect(await verifyIdToken(bad, token)).toBeNull();
  });

  it("returns null on a signature it cannot verify (foreign JWKS)", async () => {
    const { token } = await mintSession({ sub: "u" });
    const { jwks: otherJwks } = await mintSession({ sub: "other" });
    expect(await verifyIdToken(config(otherJwks), token)).toBeNull();
  });

  it("uses the injected fetch for the remote JWKS", async () => {
    const { token, jwks } = await mintSession({
      sub: "u",
      email: "a@b.c",
      name: "Ada",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(jwks)));
    const session = await verifyIdToken(config(), token, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(session?.sub).toBe("u");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("returns null when issuer or clientId is unset (unconfigured)", async () => {
    const { token, jwks } = await mintSession({ sub: "u" });
    expect(
      await verifyIdToken({ ...config(jwks), issuer: "" }, token),
    ).toBeNull();
    expect(
      await verifyIdToken({ ...config(jwks), clientId: "" }, token),
    ).toBeNull();
  });
});
