/** Public health probe (unauthenticated by design — see hooks.server.ts). */

import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = () => json({ ok: true });
