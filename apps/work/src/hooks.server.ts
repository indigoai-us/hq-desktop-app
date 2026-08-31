/**
 * Session gate + CSP (US-006).
 *
 * - The Cognito id_token lives in the httpOnly `hq_id_token` cookie; the
 *   refresh token lives in `hq_refresh_token`. This hook verifies the
 *   id_token (signature vs pool JWKS) and, if it is missing or expired,
 *   silently refreshes it. Distilled safe fields go on `event.locals.session`.
 *   Page data never contains tokens. The authenticated /api/auth/token bridge
 *   deliberately puts the current id_token in browser memory for direct
 *   hq-pro Bearer calls; it is not persisted in browser storage.
 * - Unauthenticated page requests 303 to /auth/signin; API requests get a
 *   structured 401. /auth/* and /api/health stay public.
 * - Every response carries the Content-Security-Policy from lib/server/csp
 *   (connect-src must include wss://*.amazonaws.com for the mesh socket).
 */

import type { Handle } from "@sveltejs/kit";

import { authConfig } from "$lib/server/auth";
import { buildCsp } from "$lib/server/csp";
import { localDevSession } from "$lib/server/local-dev-session";
import { restoreSession } from "$lib/server/session-cookies";

function isPublic(pathname: string): boolean {
  return (
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    pathname === "/api/health"
  );
}

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.session = await restoreSession(event.cookies, {
    secure: event.url.protocol === "https:",
    fetch: event.fetch,
    config: authConfig({ origin: event.url.origin }),
  });

  // DEV-ONLY local session bypass. Double-guarded by `import.meta.env.DEV`
  // (true only under `vite dev`; statically false in any production build, so
  // this branch is dead-code eliminated from the Vercel bundle) AND the
  // explicit `HQ_LOCAL_MESH=1` opt-in. Skips Cognito so the hosted-web
  // MQTT + REST shell can be opened without a cookie. It does not read
  // ~/.hq. Only runs when no real session was established above.
  if (!event.locals.session) {
    const local = localDevSession({
      dev: import.meta.env.DEV,
      meshFlag: process.env.HQ_LOCAL_MESH,
    });
    if (local) event.locals.session = local;
  }

  const { pathname } = event.url;
  if (!event.locals.session && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ error: "Unauthenticated", code: "UNAUTHENTICATED" }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "content-security-policy": buildCsp(),
          },
        },
      );
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/auth/signin",
        "content-security-policy": buildCsp(),
      },
    });
  }

  const response = await resolve(event);
  response.headers.set("content-security-policy", buildCsp());
  return response;
};
