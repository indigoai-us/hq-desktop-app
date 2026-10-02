import { expect, test } from "@playwright/test";

import { signIn } from "./helpers";

/**
 * Empty-state guard for the shared display library.
 *
 * The signed-in shell must paint honest "No data" / "No conversations" states —
 * never the Corey theater fixtures.
 */
test.describe("v2 display library: empty states, no fixture fallback", () => {
  test.beforeEach(async ({ context }) => {
    await signIn(context);
  });

  test("default shell renders No data instead of fixture theater", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    // With no live data the shell lands on the built-in #welcome channel
    // (main c1aad113) and lists nothing else.
    await expect(
      page.getByRole("heading", { name: "welcome", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByTestId("chat-sidebar").getByRole("button", { name: "welcome", exact: true }),
    ).toBeVisible();

    await expect(page.getByTestId("run-complete-card")).toHaveCount(0);

    const body = (await page.locator("body").innerText()).toLowerCase();
    for (const forbidden of [
      "agent-orchestrator",
      "nightly triage sweep",
      "reconnecting",
      "channel-directory",
      "http-404",
      "can't fetch",
      "cant fetch",
      "select a conversation",
    ]) {
      expect(body, `fixture/error text present: "${forbidden}"`).not.toContain(
        forbidden,
      );
    }

    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
  });

  test("sidebar chrome still opens; rosters stay empty", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();

    await page.getByTestId("chat-filter").click();
    const filterPopover = page.getByTestId("chat-filter-popover");
    await expect(filterPopover).toBeVisible();
    await expect(filterPopover).toContainText("Sort by");
    await expect(filterPopover.getByText("Bryan", { exact: true })).toHaveCount(
      0,
    );
    await expect(filterPopover.getByText("Sofia", { exact: true })).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    await page.getByTestId("chat-search").click();
    const switcher = page.getByTestId("chat-search-overlay");
    await expect(switcher).toBeVisible();
    // The only conversation is the built-in #welcome channel.
    await expect(switcher.getByRole("option")).toHaveCount(1);
    await expect(switcher.getByRole("option", { name: "welcome" })).toBeVisible();
    await expect(switcher.getByText("hq-desktop")).toHaveCount(0);
    await expect(switcher.getByText("agent-orchestrator")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // "+" is a menu now (New message / New channel) — pick New message.
    await page.getByTestId("chat-new-message").click();
    await page.getByRole("menuitem", { name: /^New message/ }).click();
    const compose = page.getByTestId("new-message-sheet");
    await expect(compose).toBeVisible();
    await expect(compose.getByText("No matches")).toBeVisible();
    await expect(compose.getByText("hq-desktop")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("notifications do not paint Corey theater data; settings open on web", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();

    // Notifications open as the console-rail popover (US-016).
    await page.getByTestId("titlebar-notifications").click();
    const popover = page.getByTestId("notifications-popover");
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId("notifications-empty")).toBeVisible();
    await expect(
      page.getByText("library-ia-v2.md · Indigo · Files"),
    ).toHaveCount(0);
    // A click outside closes the popover.
    await page.getByRole("heading", { name: "welcome", exact: true }).click();
    await expect(popover).toHaveCount(0);

    await expect(page.getByTestId("chat-user-card")).toHaveCount(0);
    await page.getByTestId("rail-you").click();
    await expect(page.getByTestId("account-settings")).toBeVisible();
    await expect(page.getByTestId("account-sign-out")).toBeVisible();
    await page.getByTestId("account-settings").click();
    // Settings opens the console-rail account Settings page (US-035).
    await expect(page.getByTestId("account-host")).toHaveAttribute("data-page", "settings");
    await expect(page.getByTestId("account-pages")).toContainText("HQ settings");
    await expect(page.getByTestId("settings-host")).toHaveCount(0);
    await expect(page.getByTestId("library-overlay")).toHaveCount(0);
    await expect(page.getByTestId("titlebar-core-pill")).toHaveCount(0);
  });

  test("meetings destination is the prototype page, not the unavailable fallback", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("desktop-shell")).toBeVisible();
    await page.getByTestId("rail-meetings").click();
    await expect(page.getByTestId("desktop-alt-meetings")).toBeVisible();
    await expect(page.getByTestId("meetings-feature-hidden")).toHaveCount(0);
    await expect(
      page.getByText("Meetings aren't available for this account"),
    ).toHaveCount(0);
    await expect(page.getByTestId("meetings-connect-calendar")).toBeVisible();
    await expect(
      page.getByPlaceholder("Paste a Zoom or Google Meet URL"),
    ).toBeVisible();
    await expect(page.getByTestId("meetings-url-invite")).toBeVisible();

    // The primary "Connect calendar" control now starts in-app Google OAuth
    // (POST /v1/google/connect) rather than the old dead console handoff, so it
    // no longer opens an hq.computer popup. The console handoff survives as the
    // secondary "Manage in console" footer link — assert that reaches the
    // personal integrations console.
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("meetings-manage").click();
    const popup = await popupPromise;
    expect(popup.url()).toContain("hq.computer");
    expect(popup.url()).toContain("personal");
    expect(popup.url()).toContain("integrations");
    await popup.close();
  });
});
