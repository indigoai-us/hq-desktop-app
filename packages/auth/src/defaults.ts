/**
 * Public Cognito identifiers for the HQ vault-client.
 *
 * These are not secrets (app client id + pool + hosted-UI domain). Desktop
 * already inlined them so `vite` / Tauri works with no env file. Web local
 * dev uses the same set so `pnpm exec vite dev` can sign in without a
 * special .env. Production (Vercel / work-web) still supplies its own env.
 */

export const VAULT_AWS_REGION = "us-east-1";
export const VAULT_USER_POOL_ID = "us-east-1_AXf6Kb5nE";
export const VAULT_CLIENT_ID = "7acei2c8v870enheptb1j5foln";
export const VAULT_HOSTED_UI_DOMAIN =
  "vault-indigo-hq-prod.auth.us-east-1.amazoncognito.com";
export const WEB_DEV_APP_ORIGIN = "http://localhost:3000";

export function vaultIssuer(
  region: string = VAULT_AWS_REGION,
  pool: string = VAULT_USER_POOL_ID,
): string {
  return `https://cognito-idp.${region}.amazonaws.com/${pool}`;
}
