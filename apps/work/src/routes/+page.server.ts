/**
 * Root route renders the full V2 desktop shell for signed-in users (see
 * +page.svelte). It no longer redirects '/' → /chat — the shell IS the default
 * signed-in surface, and the channel rail + title bar are the navigation.
 *
 * Signed-out requests still go to /auth/signin. The global session hook
 * (hooks.server.ts) already 303s unauthenticated page requests there; this is
 * defense in depth so the invariant holds even if the hook's public-path set
 * changes.
 *
 * Web never reads ~/.hq. Localhost and Vercel share the same path: session
 * cookie → authenticated token endpoint → direct hq-pro REST + MQTT + shallow
 * localStorage. Desktop owns the machine cache; the first-access installer
 * lives there, not here.
 */

import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.session) redirect(303, "/auth/signin");
  return {};
};
