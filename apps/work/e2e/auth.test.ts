/**
 * US-006 auth E2E — runnable in CI with no real Cognito:
 * (a) an unauthenticated visit to / redirects (303) to /auth/signin;
 * (b) with an injected session (RS256 id_token minted with the committed
 *     test key, verified server-side via COGNITO_TEST_JWKS) the shell
 *     renders with the user's identity and mesh status.
 */

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test.describe("auth: session gate", () => {
  test("unauthenticated visit to / redirects to sign-in", async ({ page }) => {
    const response = await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/auth/signin");
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Sign in to HQ Work" }),
    ).toBeVisible();
  });

  test("unauthenticated token bridge gets a structured 401", async ({
    request,
  }) => {
    const res = await request.get("/api/auth/token");
    expect(res.status()).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthenticated",
      code: "UNAUTHENTICATED",
    });
  });

  test("health stays public", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("authenticated visit to / renders the desktop shell", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto("/");
    // The root IS the V2 desktop shell now — no '/' → /chat redirect.
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    // The hq-pro test origin is intentionally unreachable; the shell mounts
    // its boot skeleton instead of a live channel row.
    await expect(page.getByTestId("channel-skeleton")).toBeVisible();
  });

  test("responses carry the realtime-capable CSP", async ({
    page,
    context,
  }) => {
    await signIn(context);
    // goto('/') follows the 303 into the shell; the hook sets CSP on every
    // response, including the final /chat document.
    const response = await page.goto("/");
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("wss://*.amazonaws.com");
    expect(csp).toContain("https://hqapi.example.test");
  });

  test("the session endpoint returns the signed-in identity and nothing else", async ({
    context,
    request,
  }) => {
    // The root layout is a universal load, so this endpoint — not `locals` —
    // is how the web shell learns who is signed in. It is also the only new
    // surface the mobile fix added to the hosted app, so it is pinned against
    // a real cookie and a real verification pass, not a stubbed session.
    await signIn(context);
    const cookies = await context.cookies();
    const cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const res = await request.get("/api/auth/session", {
      headers: { cookie: cookieHeader },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({
      user: {
        sub: "person-corey",
        email: "corey@getindigo.ai",
        name: "Corey Epstein",
      },
    });
    // The id_token has its own deliberate bridge. It must never come through
    // here as a side effect of the identity read.
    expect(await res.text()).not.toContain("eyJ");
  });

  test("the shell boots without asking for server data", async ({
    page,
    context,
  }) => {
    // The reason the root route has no server load: `/__data.json` is what a
    // static desktop/mobile bundle cannot answer, and a 404 there replaces the
    // whole app with SvelteKit's 404 page. Asserting it against the real
    // client router here catches a server load being reintroduced on a route
    // whose only other symptom is a blank screen on a phone.
    const requested: string[] = [];
    page.on("request", (req) => requested.push(new URL(req.url()).pathname));
    await signIn(context);
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    expect(requested.filter((p) => p.endsWith("/__data.json"))).toEqual([]);
    expect(requested).toContain("/api/auth/session");
  });
});
