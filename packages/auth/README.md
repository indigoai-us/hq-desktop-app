# @hq/auth

Platform-pure core of the Cognito hosted-UI **authorization-code + PKCE** flow,
shared by every HQ Work surface: web (dev `localhost:3000` and prod
`work.hq.computer`), desktop (Tauri `hq-work://` deep-link), and mobile.

## Why this exists

The auth logic used to live only in `apps/web`. This package extracts the
platform-agnostic core so all surfaces run **one** implementation. There is
**no SvelteKit, no `$env`, no Node-only API** in here — each host assembles an
`AuthConfig` from its own environment and **injects `fetch`**. Cookie set/get,
redirects, and the conditional-`Secure` decision stay in the host; only the
cookie **name** constants are shared.

## Exports

- Types: `AuthConfig`, `Session`, `SignInProvider`, `SignInProviderConfig`,
  `AuthorizeParams`, `ExchangeParams`, `TokenResponse`, `LogoutParams`,
  `SignInSearchParams`
- Config predicate: `isSigninConfigured(config)`
- PKCE: `randomToken(bytes?)`, `pkceChallenge(verifier)` (Web-standard
  `crypto.subtle` — Node/browser/Tauri)
- Flow: `buildAuthorizeUrl(config, params)`,
  `exchangeCodeForTokens(config, params)` (injected `fetch`),
  `refreshTokens(config, params)` (`grant_type=refresh_token`, injected `fetch`),
  `verifyIdToken(config, token)` (jose; data-driven test-JWKS seam),
  `buildLogoutUrl(config, params)`
- Providers: `SIGNIN_PROVIDERS`, `SIGNIN_PROVIDER_CONFIG`,
  `isAllowedSignInProvider`, `isEnabledSignInProvider`
- Return-to guard: `normalizeCallback`, `firstParam`, `searchParamsToSignIn`
- Cookie names: `ID_TOKEN_COOKIE`, `REFRESH_TOKEN_COOKIE`, `PKCE_VERIFIER_COOKIE`,
  `OAUTH_STATE_COOKIE`, `POST_LOGIN_REDIRECT_COOKIE`
- Error: `TokenExchangeError`

## The test-JWKS seam is data-driven

`verifyIdToken(config, token)` verifies against `config.testJwks` when it is
present, otherwise against the live pool JWKS at
`${issuer}/.well-known/jwks.json`. This library **never reads env** — the host
decides whether to populate `testJwks`. In `apps/web` that gate stays in the
web adapter (`apps/web/src/lib/server/auth.ts`): `testJwks` is set **only when**
`COGNITO_TEST_JWKS` is present **and** `VERCEL_ENV !== "production"`, so
production always verifies real tokens against the real pool.

## Per-surface config

Each surface builds the same `AuthConfig` shape (`clientId`, `hostedUiDomain`,
`issuer`, `appOrigin`, optional `testJwks`) and passes a fully-formed
`redirectUri` to `buildAuthorizeUrl` / `exchangeCodeForTokens`:

| Surface    | Cognito app client | `redirectUri`                            |
| ---------- | ------------------ | ---------------------------------------- |
| web (dev)  | `vault-client`     | `http://localhost:3000/auth/callback`    |
| web (prod) | `work-web`         | `https://work.hq.computer/auth/callback` |
| desktop    | `vault-client`     | `hq-work://app/connect/cognito-callback` |

`buildLogoutUrl` takes the registered `logout_uri` as `returnTo` (web:
`${appOrigin}/auth/signin`).

The host owns cookie writes: `id_token` in an httpOnly, `SameSite=Lax` cookie
that is `Secure` over https and non-`Secure` over `http://localhost` (so dev
does not silently drop it), plus a longer-lived `refresh_token` cookie of the
same shape so the session can outlive the 1-hour id_token. The PKCE verifier,
CSRF state, and post-login redirect ride short-lived transient cookies with
the same conditional-`Secure` rule.

## Desktop readiness

`@hq/auth` has **no web-only dependencies** (only `jose` + Web-standard
crypto). `apps/desktop` imports it for PKCE, authorize, token exchange, and
verify. The desktop host uses the already-registered vault-client loopback
`http://localhost:8765/callback` (same as `hq login`) so sign-in works before
the `hq-work://app/connect/cognito-callback` URL is live on the Cognito
client. That custom scheme is listed in hq-pro `infra/cognito.ts` and becomes
the authorize redirect after deploy.
