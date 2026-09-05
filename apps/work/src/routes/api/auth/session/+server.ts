import { json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

/**
 * GET /api/auth/session — the web shell's identity read.
 *
 * The root layout is a universal load (so the static desktop/mobile bundle can
 * run it), which means it cannot reach `locals`. This is the same verified
 * session it used to read directly, projected field by field: only the three
 * display fields the shell uses ever leave the server. No token and no raw
 * claim set — the id_token has its own deliberate, no-store bridge at
 * /api/auth/token.
 *
 * `hooks.server.ts` answers an unauthenticated /api/* with a structured 401
 * before this runs, so the null-session branch below only matters if that gate
 * changes.
 */
export const GET: RequestHandler = ({ locals }) => {
  const session = locals.session;
  return json(
    {
      user: session
        ? { sub: session.sub, email: session.email, name: session.name }
        : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
};
