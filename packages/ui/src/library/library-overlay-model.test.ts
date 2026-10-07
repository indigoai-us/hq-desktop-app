import { describe, expect, it } from "vitest";
import {
  buildLibraryNavRows,
  formatNavLabel,
  indexInstalledPacks,
  libraryOverlayCapabilities,
  marketplaceBadgeForListing,
  overlayTabToLibraryTab,
  resolveOverlayTab,
  toMarketplaceCards,
  type InstalledPackRef,
} from "./library-overlay-model";
import type { MarketplaceListing } from "../marketplace/marketplace.js";
import { TAURI_CAPABILITIES, WEB_CAPABILITIES } from "@hq/platform";

function listing(
  overrides: Partial<MarketplaceListing> &
    Pick<MarketplaceListing, "id" | "slug">,
): MarketplaceListing {
  return {
    type: "skill",
    name: overrides.name ?? overrides.slug,
    version: "1.0.0",
    author: "indigo",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("library-overlay-model (US-017, OWNER-R33 Marketplace)", () => {
  describe("host capabilities", () => {
    it("advertises Installed and Submit only where packs install locally", () => {
      expect(libraryOverlayCapabilities(WEB_CAPABILITIES)).toEqual({ marketplace: false });
      expect(libraryOverlayCapabilities(TAURI_CAPABILITIES)).toEqual({ marketplace: true });
    });
  });

  describe("left list", () => {
    it("is Browse, Installed, Submit with Browse first; no Skills or Workers", () => {
      const rows = buildLibraryNavRows();
      expect(rows.map((r) => formatNavLabel(r))).toEqual(["Browse", "Installed", "Submit"]);
      expect(rows.map((r) => r.id)).toEqual(["marketplace", "installed", "submit"]);
    });

    it("keeps Browse when the host cannot install packs", () => {
      expect(buildLibraryNavRows({ marketplace: false }).map((r) => r.id)).toEqual(["marketplace"]);
    });
  });

  describe("tab resolution", () => {
    it("lands the retired Skills, Workers and Profile tabs, and no tab, on Browse", () => {
      expect(
        ["skills", "workers", "profile", "marketplace", undefined].map((tab) =>
          resolveOverlayTab(tab as Parameters<typeof resolveOverlayTab>[0]),
        ),
      ).toEqual(["marketplace", "marketplace", "marketplace", "marketplace", "marketplace"]);
      expect(resolveOverlayTab("installed")).toBe("installed");
      expect(resolveOverlayTab("submit")).toBe("submit");
      expect(resolveOverlayTab("installed", { marketplace: false })).toBe("marketplace");
    });

    it("maps page tabs back to route LibraryTab", () => {
      expect(overlayTabToLibraryTab("installed")).toBe("installed");
      expect(overlayTabToLibraryTab("marketplace")).toBe("marketplace");
      expect(overlayTabToLibraryTab("submit")).toBe("submit");
    });
  });

  describe("marketplace badge derivation", () => {
    it("returns get when not installed", () => {
      const index = indexInstalledPacks([]);
      expect(
        marketplaceBadgeForListing(
          listing({ id: "1", slug: "engineering" }),
          index,
        ),
      ).toBe("get");
    });

    it("returns installed when present without update", () => {
      const installed: InstalledPackRef[] = [
        { name: "engineering", updateAvailable: false },
      ];
      const index = indexInstalledPacks(installed);
      expect(
        marketplaceBadgeForListing(
          listing({ id: "1", slug: "engineering" }),
          index,
        ),
      ).toBe("installed");
    });

    it("returns update when installed with updateAvailable", () => {
      const installed: InstalledPackRef[] = [
        {
          name: "hq-pack-gstack",
          source: "marketplace:gstack",
          updateAvailable: true,
        },
      ];
      const index = indexInstalledPacks(installed);
      expect(
        marketplaceBadgeForListing(listing({ id: "2", slug: "gstack" }), index),
      ).toBe("update");
    });

    it("builds marketplace cards with badges + search filter", () => {
      const listings = [
        listing({
          id: "1",
          slug: "engineering",
          name: "hq-pack-engineering",
          summary: "Eng",
        }),
        listing({
          id: "2",
          slug: "gstack",
          name: "gstack",
          summary: "Stack tools",
        }),
      ];
      const installed: InstalledPackRef[] = [
        { name: "engineering", updateAvailable: false },
        { name: "gstack", updateAvailable: true },
      ];
      const cards = toMarketplaceCards(listings, installed);
      expect(cards.find((c) => c.slug === "engineering")?.badge).toBe(
        "installed",
      );
      expect(cards.find((c) => c.slug === "gstack")?.badge).toBe("update");

      const filtered = toMarketplaceCards(listings, installed, "stack");
      expect(filtered.map((c) => c.slug)).toEqual(["gstack"]);
    });
  });
});
