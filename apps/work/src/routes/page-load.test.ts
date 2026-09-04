import { isRedirect } from "@sveltejs/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { load, ssr } from "./+page";

/**
 * The sign-in redirect is defence in depth: `hooks.server.ts` already 303s an
 * unauthenticated page request before this ever runs on the web. It moved from
 * a server load to a universal one so the static desktop/mobile bundle can load
 * this route at all, which makes it strictly better placed than before — it now
 * also catches a session that expires while the SPA is open.
 *
 * It must not fire in a static build. There is no `/auth/signin` document in
 * that bundle, so redirecting a native host there swaps a working shell for a
 * 404 page.
 */

type LoadEvent = Parameters<typeof load>[0];

function event(user: { sub: string } | null): LoadEvent {
  return { parent: async () => ({ user }) } as unknown as LoadEvent;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("root load", () => {
  it("sends signed-out visitors to sign-in", async () => {
    try {
      await load(event(null));
      throw new Error("expected redirect");
    } catch (err) {
      expect(isRedirect(err)).toBe(true);
      if (isRedirect(err)) expect(err.location).toBe("/auth/signin");
    }
  });

  it("does not gate signed-in users on the local work-mesh cache", async () => {
    const data = await load(event({ sub: "person-test" }));
    expect(data).toEqual({});
    expect(data).not.toHaveProperty("overlay");
  });

  it("does not send a native host to the web sign-in route", async () => {
    vi.stubEnv("TAURI", "1");
    // No web session exists on a phone, and the static bundle has no
    // /auth/signin page to land on.
    await expect(load(event(null))).resolves.toEqual({});
  });

  it("renders on the client so the static bundle needs no prerender pass", () => {
    // adapter-static emits the SPA fallback; server rendering this route would
    // reintroduce a build-time dependency on data the shell fetches at runtime.
    expect(ssr).toBe(false);
  });
});
