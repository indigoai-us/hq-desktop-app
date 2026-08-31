/**
 * App-shell E2E (signed-in): drives the real browser UI through the injected
 * test-JWKS session (see e2e/helpers.ts). Proves the V2 shell is the ONLY
 * signed-in surface after the display-library collapse:
 *
 *  1. the root route renders the sidebar-first windowed DesktopApp shell (no
 *     '/' → /chat redirect, no fabricated top-nav);
 *  2. the shell paints the channel rail + a selected channel with a composer;
 *  3. the LEGACY (app) deep-link routes are collapsed — they no longer mount
 *     their own backend-driven chrome (which produced the 404 /
 *     "Realtime: reconnecting" / "Select a conversation" error screens). No
 *     legacy path shows a data-fetch error; the shell owns all navigation.
 */

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

/** Legacy per-screen paths that used to open their own MeshClient + REST. */
const LEGACY_PATHS = [
  "/chat",
  "/board",
  "/projects",
  "/marketplace",
  "/library",
  "/files",
  "/meetings",
  "/deployments",
  "/settings",
];

test.describe("desktop shell: signed-in default surface", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("root renders the windowed shell (no redirect, no fabricated nav)", async ({
    page,
  }) => {
    await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    // The retired fabricated top-nav + "HQ Work" placeholder must be gone.
    await expect(page.getByTestId("app-nav")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "HQ Work" })).toHaveCount(0);
  });

  test("the shell paints a loading skeleton when there is no live data", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    // The pre-selection boot state is a shimmer skeleton, not a "No data"
    // flash (work-desktop-dogfood).
    await expect(page.getByTestId("channel-skeleton")).toBeVisible();
    await expect(page.getByTestId("conversation-composer")).toHaveCount(0);
  });

  for (const path of LEGACY_PATHS) {
    test(`legacy deep-link ${path} is collapsed — no data-fetch error screen`, async ({
      page,
    }) => {
      await page.goto(path);
      // The old backend-driven chat chrome must NOT mount (it is what produced
      // the "reconnecting" / "Select a conversation" errors).
      await expect(page.getByTestId("chat-page")).toHaveCount(0);
      const body = (await page.locator("body").innerText()).toLowerCase();
      for (const forbidden of [
        "reconnecting",
        "channel-directory",
        "http-404",
        "select a conversation",
      ]) {
        expect(body, `error text at ${path}: "${forbidden}"`).not.toContain(
          forbidden,
        );
      }
    });
  }
});
