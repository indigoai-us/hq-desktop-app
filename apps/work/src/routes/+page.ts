import { redirect } from "@sveltejs/kit";

import { isStaticBuild } from "$lib/static-build";

import type { PageLoad } from "./$types";

/**
 * adapter-static emits the SPA fallback for this route, and the shell fetches
 * everything it renders at runtime, so there is nothing to server-render.
 */
export const ssr = false;

/**
 * Defence in depth on the web: `hooks.server.ts` already 303s an
 * unauthenticated request for `/` before this runs. Keeping the check here
 * means the invariant survives a change to the hook's public-path set — and,
 * now that it is a universal load, it also catches a session that expires
 * while the SPA is open rather than leaving an empty shell on screen.
 *
 * It must not fire in a static build: that bundle contains no `/auth/signin`
 * document, and a phone has no web session to begin with. Native hosts run
 * their own auth through `WorkShell`'s `onUnauthorized`.
 */
export const load: PageLoad = async ({ parent }) => {
  if (isStaticBuild()) return {};
  const { user } = await parent();
  if (!user) redirect(303, "/auth/signin");
  return {};
};
