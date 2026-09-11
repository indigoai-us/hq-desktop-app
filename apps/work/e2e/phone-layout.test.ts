/**
 * Phone layout.
 *
 * The shell is one Svelte source for web, desktop and mobile, so "make it fit
 * a phone" is a width branch in the shared component, not a second component.
 * These run the real built app in a real browser at a phone viewport, because
 * the thing being asserted is layout — a source-text assertion about a media
 * query would pass whether or not the rule actually applied.
 *
 * The failure being prevented: `.chat-sidebar` is `flex: 0 0 260px`. On a
 * 390px screen that permanently reserves two thirds of the width, leaving the
 * conversation 130px, which is what the first mobile build rendered.
 */

import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

test.describe("phone layout", () => {
  test.use({ viewport: PHONE });

  test("the conversation is not sharing the screen with a channel column", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await expect(page.getByTestId("chat-sidebar")).toBeHidden();
  });

  test("the conversation still loads while the list is closed", async ({
    page,
    context,
  }) => {
    // The channel list is what loads the roster and picks the first channel.
    // Closing it by unmounting it therefore leaves a phone with no selected
    // conversation and nothing on screen — worse than the squeezed column it
    // replaced. It has to stay mounted and merely move out of the way.
    await signIn(context);
    await page.goto("/");
    await expect(page.getByTestId("chat-sidebar")).toBeHidden();
    // The list falls back to #setup once the directory fails or the boot
    // window elapses (ChatSidebar.auto-open-setup.test.ts). Asserting the
    // settled channel rather than the skeleton matters: the skeleton is the
    // pre-timeout state and shows whether or not anything is ever selected.
    await expect(page.getByRole("heading", { name: "setup" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("conversation-boot-error")).toHaveCount(0);
  });

  test("the channel list opens over the conversation, not beside it", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await page.getByRole("button", { name: "Show sidebar" }).click();

    const sidebar = page.getByTestId("chat-sidebar");
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box).not.toBeNull();
    // An overlay claims most of the screen while it is open. A 260px inline
    // column would sit well under this on a 390px viewport.
    expect(box!.width).toBeGreaterThan(PHONE.width * 0.7);
  });

  test("closing the list gives the whole screen back", async ({
    page,
    context,
  }) => {
    await signIn(context);
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    await expect(page.getByTestId("chat-sidebar")).toBeHidden();
  });
});

test.describe("the desktop layout is unchanged", () => {
  test.use({ viewport: DESKTOP });

  test("keeps the channel list as a column beside the conversation", async ({
    page,
    context,
  }) => {
    // The width branch must not leak upward: this is the same component the
    // hosted web app and the desktop build render.
    await signIn(context);
    await page.goto("/");
    const sidebar = page.getByTestId("chat-sidebar");
    await expect(sidebar).toBeVisible();
    const box = await sidebar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThan(DESKTOP.width * 0.4);
  });
});
