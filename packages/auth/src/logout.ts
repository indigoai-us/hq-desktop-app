/**
 * Build the Cognito hosted-UI /logout URL that ends the hosted session and
 * returns the browser to `returnTo` (a fully-formed, registered logout_uri).
 */

import type { AuthConfig } from "./types.js";

export interface LogoutParams {
  /** Registered logout_uri to return to (e.g. `${appOrigin}/auth/signin`). */
  returnTo: string;
}

export function buildLogoutUrl(
  config: AuthConfig,
  params: LogoutParams,
): string {
  const logout = new URL(`https://${config.hostedUiDomain}/logout`);
  logout.searchParams.set("client_id", config.clientId);
  logout.searchParams.set("logout_uri", params.returnTo);
  return logout.toString();
}
