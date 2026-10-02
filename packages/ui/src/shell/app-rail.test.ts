import { describe, expect, it } from "vitest";

import {
  MAX_PINNED_COMPANY_TILES,
  RAIL_PLACEHOLDERS,
  activeRailItemId,
  railDestination,
  railItems,
  railPlaceholderForPage,
  railPlaceholderPage,
  railTooltip,
} from "./app-rail.js";
import { canonicalizeDestination } from "./navigation-history.js";

describe("app rail model (console-rail US-003)", () => {
  it("lists items in the decided order", () => {
    const items = railItems(
      [
        { uid: "co_a", label: "Indigo" },
        { uid: "co_b", label: "LiveRecover" },
      ],
      "Stefan Johnson",
    );
    expect(items.map((item) => item.id)).toEqual([
      "home",
      "meetings",
      "company:co_a",
      "company:co_b",
      "more-companies",
      "library",
      "deployments",
      "telemetry",
      "secrets",
      "connections",
      "outpost",
      "you",
    ]);
  });

  it("caps pinned company tiles at six", () => {
    const companies = Array.from({ length: 9 }, (_, i) => ({ uid: `co_${i}`, label: `Co ${i}` }));
    const tiles = railItems(companies, "You").filter((item) => item.kind === "company");
    expect(tiles).toHaveLength(MAX_PINNED_COMPANY_TILES);
  });

  it("routes every item to a destination the navigation history accepts", () => {
    for (const item of railItems([{ uid: "co_a", label: "Indigo" }], "You")) {
      expect(() => canonicalizeDestination(railDestination(item))).not.toThrow();
    }
    expect(railDestination(railItems([], "You")[1]!)).toEqual({ kind: "meetings" });
    const library = railItems([], "You").find((item) => item.kind === "library")!;
    expect(railDestination(library)).toEqual({
      kind: "extra",
      page: "rail-library",
    });
    expect(railDestination(library, { localFiles: false })).toEqual({
      kind: "extra",
      page: "rail-library",
    });
  });

  it("lands a company tile on that company's Atlas (US-009)", () => {
    const tile = railItems([{ uid: "co_a", label: "Indigo" }], "You").find(
      (item) => item.kind === "company",
    )!;
    expect(railDestination(tile)).toEqual({
      kind: "extra",
      page: "company-page-atlas",
      companyUid: "co_a",
    });
  });

  it("redirects the removed Overview page to Atlas (US-009)", () => {
    expect(
      canonicalizeDestination({ kind: "extra", page: "company-page-overview", companyUid: "co_a" }),
    ).toEqual({ kind: "extra", page: "company-page-atlas", param: null, companyUid: "co_a" });
  });

  it("names the story that builds each placeholder page", () => {
    for (const placeholder of Object.values(RAIL_PLACEHOLDERS)) {
      expect(placeholder.story).toMatch(/^US-\d{3}$/);
      expect(railPlaceholderForPage(railPlaceholderPage(placeholder.id))).toBe(placeholder);
    }
    expect(railPlaceholderForPage("rail-unknown")).toBeNull();
    expect(railPlaceholderForPage("sessions")).toBeNull();
  });

  it("rolls company-channel unread onto the company tile", () => {
    const [tile] = railItems([{ uid: "co_a", label: "Indigo", unreadCount: 4 }], "You").filter(
      (item) => item.kind === "company",
    );
    expect(tile && tile.kind === "company" && tile.unreadCount).toBe(4);
    expect(railTooltip(tile!)).toBe("Indigo · 4 unread");
  });

  it("puts the unread count in the Home tooltip", () => {
    const home = railItems([], "You")[0]!;
    expect(railTooltip(home, { unread: 3 })).toBe("Home · 3 unread");
    expect(railTooltip(home)).toBe("Home · Messages & Inbox");
  });

  it("selects the rail item for the current view", () => {
    const base = { tenantCompanyId: null, extraPageId: null, settingsSection: null };
    expect(activeRailItemId({ ...base, view: "conversation" })).toBe("home");
    expect(activeRailItemId({ ...base, view: "conversation", tenantCompanyId: "co_a" })).toBe(
      "company:co_a",
    );
    expect(activeRailItemId({ ...base, view: "meetings" })).toBe("meetings");
    expect(activeRailItemId({ ...base, view: "explorer" })).toBe("library");
    expect(
      activeRailItemId({ ...base, view: "extra", extraPageId: railPlaceholderPage("outpost") }),
    ).toBe("outpost");
    expect(activeRailItemId({ ...base, view: "library" })).toBe("library");
    expect(activeRailItemId({ ...base, view: "projects" })).toBeNull();
    expect(activeRailItemId({ ...base, view: "extra", extraPageId: "account-profile" })).toBe("you");
    expect(activeRailItemId({ ...base, view: "extra", extraPageId: "account-billing" })).toBe("you");
  });
});
