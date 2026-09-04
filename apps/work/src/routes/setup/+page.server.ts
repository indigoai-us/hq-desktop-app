/**
 * Local HQ install + CLI setup is desktop-only. The web app cannot
 * control the user's machine, so /setup always bounces to the shell.
 */

import { redirect } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.session) redirect(303, "/auth/signin");
  redirect(303, "/");
};
