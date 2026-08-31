import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

test.describe("smoke: desktop shell", () => {
  // The shell sits behind the US-006 session gate; smoke runs authenticated
  // via the injected test session (see e2e/helpers.ts).
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("root renders the V2 desktop shell (no redirect, no reactive loop)", async ({
    page,
  }) => {
    // Regression guard: the ConversationView mounts on the default view, so an
    // effect_update_depth_exceeded loop here would blank the shell. Fail loudly
    // on any page error instead of screenshotting a frozen app.
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/");
    // The root IS the shell now — no '/' → /chat redirect, no fabricated nav.
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await expect(page.getByTestId("app-nav")).toHaveCount(0);

    expect(
      pageErrors,
      `unexpected page errors: ${pageErrors.join("; ")}`,
    ).toEqual([]);
  });

  test("the empty shell owns its own scroll", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("channel-skeleton")).toBeVisible();
    await expect(page.getByTestId("conversation-composer")).toHaveCount(0);

    // Full-bleed contract: the document/body never scrolls — the shell owns
    // all internal scrolling.
    const documentScrolls = await page.evaluate(() => {
      const d = document.documentElement;
      return (
        d.scrollHeight > d.clientHeight ||
        document.body.scrollHeight > window.innerHeight
      );
    });
    expect(documentScrolls).toBe(false);
  });
});
