/**
 * GET /auth/signout — clear the session cookies and end the Hosted UI session.
 */

import { buildLogoutUrl } from "@hq/auth";
import { redirect } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

import { authConfig, isSigninConfigured } from "$lib/server/auth";
import { clearSessionCookies } from "$lib/server/session-cookies";

export const GET: RequestHandler = ({ cookies, url }) => {
  clearSessionCookies(cookies);
  const config = authConfig({ origin: url.origin });
  if (!isSigninConfigured(config)) {
    redirect(303, "/auth/signin");
  }
  redirect(
    303,
    buildLogoutUrl(config, { returnTo: `${config.appOrigin}/auth/signin` }),
  );
};
