/**
 * @hq/auth — platform-pure Cognito hosted-UI auth core.
 *
 * One config-driven implementation of the authorization-code + PKCE flow,
 * shared by web (dev localhost + prod work.hq.computer), desktop (hq-work://
 * deep-link), and mobile. Every host assembles an {@link AuthConfig} from its
 * own env/settings and injects `fetch`; nothing here reads env, imports
 * SvelteKit, or uses Node-only APIs. Cookie set/get stays per-platform — only
 * the cookie NAME constants are shared. See README.md for per-surface config.
 */

export type { AuthConfig, Session } from "./types.js";
export { isSigninConfigured } from "./config.js";
export {
  VAULT_AWS_REGION,
  VAULT_CLIENT_ID,
  VAULT_HOSTED_UI_DOMAIN,
  VAULT_USER_POOL_ID,
  WEB_DEV_APP_ORIGIN,
  vaultIssuer,
} from "./defaults.js";
export {
  ID_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  PKCE_VERIFIER_COOKIE,
  OAUTH_STATE_COOKIE,
  POST_LOGIN_REDIRECT_COOKIE,
} from "./cookies.js";
export { randomToken, pkceChallenge } from "./pkce.js";
export { buildAuthorizeUrl, type AuthorizeParams } from "./authorize.js";
export {
  exchangeCodeForTokens,
  refreshTokens,
  TokenExchangeError,
  type ExchangeParams,
  type RefreshParams,
  type TokenResponse,
} from "./token.js";
export { verifyIdToken, type VerifyIdTokenOptions } from "./verify.js";
export { buildLogoutUrl, type LogoutParams } from "./logout.js";
export {
  normalizeCallback,
  firstParam,
  searchParamsToSignIn,
  type SignInSearchParams,
} from "./callback.js";
export {
  SIGNIN_PROVIDERS,
  SIGNIN_PROVIDER_CONFIG,
  isAllowedSignInProvider,
  isEnabledSignInProvider,
  type SignInProvider,
  type SignInProviderConfig,
} from "./providers.js";
