import { describe, expect, it } from "vitest";

import { GET } from "./+server";

/**
 * The web shell reads its identity from here because the root layout is a
 * universal load now and cannot touch `locals` directly.
 *
 * The one thing this endpoint must never do is widen what leaves the server.
 * `locals.session` carries the verified Cognito claims; only the three display
 * fields the shell actually uses are projected out. In particular no token and
 * no raw claim set — the id_token has its own deliberate, no-store bridge at
 * /api/auth/token.
 */

type Handler = Parameters<typeof GET>[0];

function event(session: Record<string, unknown> | null): Handler {
  return { locals: { session } } as unknown as Handler;
}

describe("GET /api/auth/session", () => {
  it("returns only the display identity the shell needs", async () => {
    const res = await GET(
      event({
        sub: "person-test",
        email: "a@b.test",
        name: "A Tester",
        idToken: "SECRET",
        groups: ["admin"],
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      user: { sub: "person-test", email: "a@b.test", name: "A Tester" },
    });
  });

  it("never lets a token or extra claim through", async () => {
    const res = await GET(
      event({ sub: "person-test", idToken: "SECRET", refreshToken: "ALSO-SECRET" }),
    );
    const body = await res.text();
    expect(body).not.toContain("SECRET");
  });

  it("reports a null user rather than 500 when there is no session", async () => {
    // The hook 401s an unauthenticated /api/* before this runs, so reaching
    // here without a session means the gate changed, not that the user is
    // hostile. Answer honestly instead of crashing the shell's first load.
    const res = await GET(event(null));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ user: null });
  });

  it("is not cached", async () => {
    const res = await GET(event({ sub: "person-test" }));
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
