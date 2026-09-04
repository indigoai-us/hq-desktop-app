import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test.describe("first-access work-mesh setup", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("signed-in root still lands on the shell when setup is skipped", async ({
    page,
  }) => {
    await page.goto("/");
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await expect(page.getByTestId("mesh-upgrade")).toHaveCount(0);
  });

  test("/setup without preview redirects to the shell on the e2e harness", async ({
    page,
  }) => {
    await page.goto("/setup");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("/setup?preview=1 also lands on the shell — no local install card", async ({
    page,
  }) => {
    await page.goto("/setup?preview=1");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("mesh-upgrade")).toHaveCount(0);
  });
});
