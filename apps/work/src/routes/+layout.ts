import { isStaticBuild } from "$lib/static-build";

import type { LayoutLoad } from "./$types";

/**
 * Root layout data — the signed-in user, which `WorkShell` uses as its
 * fallback host identity and tenant partition key.
 *
 * This is a universal load rather than a server load because desktop and
 * mobile run the adapter-static bundle. A server load here would make the
 * client router fetch `/__data.json` on first navigation, which a static build
 * answers with 404 — the app then renders SvelteKit's 404 page instead of the
 * shell, silently, on every launch.
 *
 * So the two hosts answer the same question by different means: the web build
 * asks its own session endpoint (the session cookie is httpOnly and cannot be
 * read here), and the static build reports no web user because the native
 * shell supplies identity to `WorkShell` directly.
 */

export interface LayoutUser {
  sub?: string | null;
  email?: string | null;
  name?: string | null;
}

function toUser(value: unknown): LayoutUser | null {
  if (!value || typeof value !== "object") return null;
  const { sub, email, name } = value as Record<string, unknown>;
  if (typeof sub !== "string" || !sub) return null;
  return {
    sub,
    email: typeof email === "string" ? email : null,
    name: typeof name === "string" ? name : null,
  };
}

export const load: LayoutLoad = async ({ fetch }) => {
  if (isStaticBuild()) return { user: null };
  try {
    const res = await fetch("/api/auth/session");
    // An unauthenticated request is answered 401 by hooks.server, and a
    // misrouted one can return the SPA fallback document. Neither is worth
    // taking the whole shell down for: both mean "no web user yet".
    if (!res.ok) return { user: null };
    const body = (await res.json()) as { user?: unknown };
    return { user: toUser(body?.user) };
  } catch {
    return { user: null };
  }
};
