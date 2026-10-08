/**
 * Console-rail e2e fixtures (US-039). Routes the HQ Pro API the preview
 * server points at (hqapi.example.test) to a small in-memory tenant: one
 * signed-in owner and one company. Unknown reads return an empty body so
 * every page paints its empty or skeleton state instead of a network error.
 */
import type { Page, Route } from "@playwright/test";

export const COMPANY = {
  companyUid: "cmp_indigo",
  companySlug: "indigo",
  companyName: "Indigo",
  role: "owner",
  status: "active",
  kind: "company",
  state: "synced",
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
    body: JSON.stringify(body),
  });

export async function routeConsoleRailApi(page: Page): Promise<void> {
  await page.route("https://hqapi.example.test/**", async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE",
        },
      });
    }
    const path = new URL(request.url()).pathname;
    if (path === "/membership/me") return json(route, { memberships: [COMPANY] });
    if (path === "/v1/identity/whoami") {
      return json(route, { personUid: "person-corey", email: "corey@getindigo.ai", displayName: "Corey Epstein" });
    }
    if (path === "/v1/profile") return json(route, { personUid: "person-corey", displayName: "Corey Epstein" });
    return json(route, {});
  });
}
