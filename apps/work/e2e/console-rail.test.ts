/**
 * Console rail on the web host (US-039): signed out → sign-in page; signed in
 * (test JWKS session cookie) → the rail paints with the membership roster,
 * the company tile lands on Atlas, and sidepane rows open real pages, not
 * placeholders. The desktop-only path (project board, task pane, Files tab,
 * New agent stepper, Meetings live) runs in apps/sync/e2e/browser.
 */
import { expect, test } from "@playwright/test";

import { routeConsoleRailApi } from "./console-rail-fixtures";
import { signIn } from "./helpers";

test.describe("console rail on the web host", () => {
  test("signed out visitors reach the sign-in page", async ({ page }) => {
    await page.goto("/auth/signin");
    await expect(page.getByRole("heading", { name: "Sign in to HQ Work" })).toBeVisible();
  });

  test("signed in: rail, company Atlas landing, and sidepane pages", async ({ page, context }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await signIn(context);
    await routeConsoleRailApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");

    const rail = page.getByTestId("app-rail");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("rail-company")).toHaveCount(1);
    await expect(page.getByTestId("titlebar-notifications")).toBeVisible();

    await page.getByTestId("rail-company").click();
    await expect(page.getByTestId("rail-company")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("atlas-landing")).toBeVisible();

    for (const [row, host] of [
      ["projects", "projects-host"],
      ["activity", "activity-host"],
      ["team", "team-page"],
      ["knowledge", "brain-page"],
      ["vault", "files-connect"],
    ] as const) {
      await page.locator(`[data-row-id="${row}"]`).click();
      await expect(page.getByTestId(host), row).toBeVisible();
      await expect(page.getByTestId("rail-placeholder"), row).toHaveCount(0);
    }

    await page.getByTestId("rail-you").click();
    await expect(page.getByTestId("account-sign-out")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("account-menu")).toHaveCount(0);

    expect(errors, errors.join("; ")).toEqual([]);
  });
});
