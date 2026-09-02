/**
 * GET /api/auth/token — bridge the verified httpOnly session into short-lived
 * browser memory. See `$lib/hq-pro-client`: hq-pro is called directly with
 * this Bearer, so this endpoint is intentionally same-origin and no-store.
 */

import type { RequestHandler } from "./$types";

import { ID_TOKEN_COOKIE } from "$lib/server/auth";
import { clientTokenResponse } from "$lib/server/client-token";
import { localDevBearer } from "$lib/server/local-dev-bearer";

export const GET: RequestHandler = ({ cookies }) =>
  clientTokenResponse(
    localDevBearer({
      cookieToken: cookies.get(ID_TOKEN_COOKIE),
      dev: import.meta.env.DEV,
      meshFlag: process.env.HQ_LOCAL_MESH,
    }),
  );
