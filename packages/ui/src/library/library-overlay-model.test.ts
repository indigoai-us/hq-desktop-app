import { describe, expect, it } from "vitest";
import {
  buildLibraryNavRows,
  filterSkillCards,
  filterWorkerCards,
  formatNavLabel,
  indexInstalledPacks,
  libraryNavCounts,
  marketplaceBadgeForListing,
  overlayTabToLibraryTab,
  resolveOverlayTab,
  skillSlug,
  skillTag,
  toMarketplaceCards,
  toSkillCards,
  toWorkerCards,
  type InstalledPackRef,
} from "./library-overlay-model";
import type { LibraryItems, LibrarySkill, LibraryWorker } from "./library.js";
import type { MarketplaceListing } from "../marketplace/marketplace.js";

const sampleItems: LibraryItems = {
  skills: [
    {
      name: "Review PR",
      description: "Review a pull request",
      scope: "root",
      path: "skills/review-pr/SKILL.md",
      allowedTools: [],
      pack: "engineering",
    },
    {
      name: "Personal note",
      description: "notes",
      scope: "personal",
      path: "personal/skills/note/SKILL.md",
      allowedTools: [],
    },
  ],
  workers: [
    {
      id: "w1",
      name: "Daily stand-up",
      type: "scheduled",
      description: "Runs stand-up",
      scope: "root",
      status: "active",
      path: "workers/standup",
      team: "eng",
    },
  ],
};

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

describe("library-overlay-model (US-017)", () => {
  describe("nav counts + rows", () => {
    it("counts skills and workers from loadLibraryRoot payload", () => {
      expect(libraryNavCounts(sampleItems)).toEqual({ skills: 2, workers: 1 });
      expect(libraryNavCounts(null)).toEqual({ skills: 0, workers: 0 });
    });

    it("keeps Installed distinct from Marketplace discovery in the left nav", () => {
      const rows = buildLibraryNavRows(sampleItems);
      expect(rows.map((r) => formatNavLabel(r))).toEqual([
        "Skills 2",
        "Workers 1",
        "Installed",
        "Marketplace",
      ]);
    });

    it("can hide workers and marketplace, keeping the cloud skills tab", () => {
      const rows = buildLibraryNavRows(sampleItems, {
        workers: false,
        marketplace: false,
      });
      expect(rows.map((r) => r.id)).toEqual(["skills"]);
    });
  });

  describe("tab resolution", () => {
    it("maps library route tabs onto overlay tabs", () => {
      expect(resolveOverlayTab("skills")).toBe("skills");
      expect(resolveOverlayTab("workers")).toBe("workers");
      expect(resolveOverlayTab("installed")).toBe("installed");
      expect(resolveOverlayTab("submit")).toBe("marketplace");
      expect(resolveOverlayTab("profile")).toBe("marketplace");
      expect(resolveOverlayTab(undefined)).toBe("skills");
      expect(resolveOverlayTab("installed", { marketplace: false })).toBe("installed");
    });

    it("maps overlay tabs back to route LibraryTab", () => {
      expect(overlayTabToLibraryTab("skills")).toBe("skills");
      expect(overlayTabToLibraryTab("workers")).toBe("workers");
      expect(overlayTabToLibraryTab("installed")).toBe("installed");
      expect(overlayTabToLibraryTab("marketplace")).toBe("installed");
    });
  });

  describe("skill / worker cards + search", () => {
    it("derives slug and tag for skill cards", () => {
      const skill = sampleItems.skills[0] as LibrarySkill;
      expect(skillSlug(skill)).toBe("review-pr");
      expect(skillTag(skill)).toBe("engineering");
      expect(skillTag(sampleItems.skills[1]!)).toBe("personal");

      const cards = toSkillCards(sampleItems.skills);
      expect(cards[0]).toMatchObject({
        name: "Review PR",
        slug: "review-pr",
        tag: "engineering",
      });
    });

    it("filters skill and worker cards by query", () => {
      const skills = toSkillCards(sampleItems.skills);
      expect(filterSkillCards(skills, "review").map((c) => c.name)).toEqual([
        "Review PR",
      ]);
      expect(filterSkillCards(skills, "zzz")).toEqual([]);

      const workers = toWorkerCards(sampleItems.workers as LibraryWorker[]);
      expect(filterWorkerCards(workers, "stand").map((w) => w.name)).toEqual([
        "Daily stand-up",
      ]);
      expect(filterWorkerCards(workers, "")).toHaveLength(1);
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
