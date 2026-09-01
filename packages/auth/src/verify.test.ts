import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "./types.js";
import { resetJwksCacheForTests, verifyIdToken } from "./verify.js";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTPOOL";
const OTHER_ISSUER =
  "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHERPOOL";
const CLIENT_ID = "client-123";

// Mint an RS256 id_token + expose its public key as a local JWKS, exactly the
// shape the host adapter would inject as config.testJwks in CI/E2E.
async function mintSession(
  claims: Record<string, unknown>,
  expOffset = 3600,
  issuer = ISSUER,
) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const mintToken = async (
    tokenClaims: Record<string, unknown>,
    tokenExpOffset = expOffset,
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(tokenClaims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + tokenExpOffset)
      .sign(privateKey);
  };
  return { token: await mintToken(claims), jwks, mintToken };
}

function config(testJwks?: JSONWebKeySet, issuer = ISSUER): AuthConfig {
  return {
    clientId: CLIENT_ID,
    hostedUiDomain: "vault-test.auth.us-east-1.amazoncognito.com",
    issuer,
    appOrigin: "https://work.hq.computer",
    testJwks,
  };
}

describe("verifyIdToken (data-driven test-JWKS seam)", () => {
  beforeEach(() => {
    resetJwksCacheForTests();
    vi.stubGlobal("fetch", async () => {
      throw new Error("unexpected global JWKS fetch");
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies a valid token against the injected testJwks and distills the session", async () => {
    const { token, jwks } = await mintSession({
      sub: "user-abc",
      email: "person@example.com",
      name: "Person Example",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(jwks)));
    const session = await verifyIdToken(config(jwks), token, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(session).not.toBeNull();
    expect(session!.sub).toBe("user-abc");
    expect(session!.email).toBe("person@example.com");
    expect(session!.name).toBe("Person Example");
    expect(session!.expiresAt).toBeGreaterThan(Date.now());
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("reuses one remote JWKS resolver across two injected request fetches", async () => {
    const first = await mintSession({ sub: "first-fetch-user" });
    const secondToken = await first.mintToken({ sub: "second-fetch-user" });
    const firstFetch = vi.fn(async () =>
      new Response(JSON.stringify(first.jwks)),
    );
    const secondFetch = vi.fn(async () =>
      new Response(JSON.stringify(first.jwks)),
    );

    await expect(
      verifyIdToken(config(), first.token, {
        fetch: firstFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual(expect.objectContaining({ sub: "first-fetch-user" }));
    await expect(
      verifyIdToken(config(), secondToken, {
        fetch: secondFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual(expect.objectContaining({ sub: "second-fetch-user" }));
    expect(firstFetch.mock.calls.length + secondFetch.mock.calls.length).toBe(
      1,
    );
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("keeps remote JWKS resolvers separate for different issuer URLs", async () => {
    const first = await mintSession({ sub: "first-pool-user" });
    const second = await mintSession(
      { sub: "second-pool-user" },
      3600,
      OTHER_ISSUER,
    );
    const firstFetch = vi.fn(async () =>
      new Response(JSON.stringify(first.jwks)),
    );
    const secondFetch = vi.fn(async () =>
      new Response(JSON.stringify(second.jwks)),
    );

    await expect(
      verifyIdToken(config(), first.token, {
        fetch: firstFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual(expect.objectContaining({ sub: "first-pool-user" }));
    await expect(
      verifyIdToken(config(undefined, OTHER_ISSUER), second.token, {
        fetch: secondFetch as unknown as typeof fetch,
      }),
    ).resolves.toEqual(expect.objectContaining({ sub: "second-pool-user" }));
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
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
