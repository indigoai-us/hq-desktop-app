/**
 * id_token verification (jose) — full JWS signature check against the pool
 * JWKS, plus issuer + audience pinning, distilled to safe session fields.
 *
 * Test seam: when `config.testJwks` is present, tokens verify against that
 * local JWK set instead of the remote pool JWKS. The seam is DATA-DRIVEN — the
 * env gate that decides whether to populate `testJwks` lives in the host
 * adapter, so this library never reads env and never weakens production on its
 * own.
 */

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import type { AuthConfig, Session } from "./types.js";

export interface VerifyIdTokenOptions {
  /** Injected fetch — required in Tauri WebKit, which rejects a detached fetch. */
  fetch?: typeof fetch;
}

const defaultRemoteJwksFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);
let currentRemoteJwksFetch: typeof fetch = defaultRemoteJwksFetch;
const cachedRemoteJwks = new Map<string, JWTVerifyGetKey>();

/** Test-only: clear process-wide remote JWKS state between isolated tests. */
export function resetJwksCacheForTests(): void {
  cachedRemoteJwks.clear();
  currentRemoteJwksFetch = defaultRemoteJwksFetch;
}

function jwksForConfig(
  config: AuthConfig,
  fetchImpl?: typeof fetch,
): JWTVerifyGetKey {
  if (config.testJwks) {
    return createLocalJWKSet(config.testJwks);
  }
  const url = `${config.issuer}/.well-known/jwks.json`;
  currentRemoteJwksFetch = fetchImpl ?? defaultRemoteJwksFetch;
  const cached = cachedRemoteJwks.get(url);
  if (cached) return cached;

  // Concurrent requests can update this slot before either resolver fetches,
  // so request A's JWKS download may use request B's fetch. That race is
  // harmless: Cognito JWKS URLs are absolute external URLs, so SvelteKit's
  // per-request fetch provides neither cookie forwarding nor a same-origin
  // SSR shortcut beyond what a plain fetch already provides.
  const getKey = createRemoteJWKSet(new URL(url), {
    // Dereference at request time so this long-lived resolver does not retain
    // any individual SvelteKit request's fetch closure.
    [customFetch]: (jwksUrl, opts) =>
      currentRemoteJwksFetch(jwksUrl, opts as RequestInit),
  });
  cachedRemoteJwks.set(url, getKey);
  return getKey;
}

/**
 * Verify an id_token (signature, issuer, audience, expiry) and distill the
 * safe session fields. Returns null on any failure — callers treat that as
 * signed-out, never as an error page.
 */
export async function verifyIdToken(
  config: AuthConfig,
  token: string,
  options?: VerifyIdTokenOptions,
): Promise<Session | null> {
  if (!config.issuer || !config.clientId) return null;
  try {
    const { payload } = await jwtVerify(
      token,
      jwksForConfig(config, options?.fetch),
      {
        issuer: config.issuer,
        audience: config.clientId,
      },
    );
    if (!payload.sub || typeof payload.exp !== "number") return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    return null;
  }
}
