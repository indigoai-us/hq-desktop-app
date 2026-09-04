/**
 * Expose safe session fields as page data. The id_token remains in the
 * httpOnly cookie and never appears here; the deliberate browser-held-token
 * posture exposes it only through authenticated GET /api/auth/token so client
 * code can call hq-pro directly with a Bearer.
 */

import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals }) => {
  return {
    user: locals.session
      ? {
          sub: locals.session.sub,
          email: locals.session.email,
          name: locals.session.name,
        }
      : null,
  };
};
