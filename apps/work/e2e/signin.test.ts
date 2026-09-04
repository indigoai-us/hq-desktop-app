/**
 * Branded sign-in E2E (V2 auth UI).
 *
 * Asserts the ported hq-console pattern:
 * (a) /auth/signin renders the BRANDED card (heading + live "Continue with
 *     Google" button), NOT Cognito's generic amazoncognito.com hosted chooser;
 * (b) GET /auth/signin?idp=Google 302s to Cognito's /oauth2/authorize with
 *     identity_provider=Google (chooser bypassed);
 * (c) Microsoft is rendered disabled (its IdP is not registered on this app
 *     client), so no live button can 400 at Cognito.
 *
 * The final Google leg (Cognito → Google consent) is a human/on-device step
 * and is deliberately NOT exercised here — we verify up to the redirect.
 */

import { expect, test } from "@playwright/test";

test.describe("branded sign-in", () => {
  test("renders the branded card, not the Cognito hosted chooser", async ({
    page,
  }) => {
    await page.goto("/auth/signin");
    expect(new URL(page.url()).pathname).toBe("/auth/signin");
    // Branded, on-origin — never bounced to amazoncognito.com.
    expect(page.url()).not.toContain("amazoncognito.com");

    await expect(
      page.getByRole("heading", { name: "Sign in to HQ Work" }),
    ).toBeVisible();

    const google = page.getByTestId("signin-google");
    await expect(google).toBeVisible();
    await expect(google).toContainText("Continue with Google");
    // It's a real deep-link into our own signin route (server turns it into
    // the Cognito redirect), not a link straight to the hosted UI.
    await expect(google).toHaveAttribute("href", /\/auth\/signin\?idp=Google/);

    // Microsoft ships disabled until its IdP is registered on the client.
    const microsoft = page.getByTestId("signin-microsoft");
    await expect(microsoft).toBeVisible();
    await expect(microsoft).toBeDisabled();
  });

  test("GET /auth/signin?idp=Google 302s to Cognito with identity_provider=Google", async ({
    request,
  }) => {
    const res = await request.get("/auth/signin?idp=Google", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(302);
    const location = res.headers()["location"] ?? "";
    expect(location).toContain("amazoncognito.com");
    expect(location).toContain("/oauth2/authorize");
    expect(location).toContain("identity_provider=Google");
    expect(location).toContain("response_type=code");
    expect(location).toContain("code_challenge_method=S256");
  });

  test("disabled Microsoft deep-link does not redirect off-origin", async ({
    request,
  }) => {
    // Even if someone hand-crafts ?idp=Microsoft, the server refuses to build a
    // deep-link for an unregistered IdP — it renders the page (200) instead of
    // 302-ing to a Cognito authorize URL that would 400.
    const res = await request.get("/auth/signin?idp=Microsoft", {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("Sign in to HQ Work");
  });
});
