import { describe, expect, it } from "vitest";

import {
  BUNDLED_PACK_COVERS,
  MARKETPLACE_COVER_HOST,
  coverFallback,
  coverForListing,
  coverTone,
  marketplaceCoverSrc,
} from "./pack-covers";
import type { MarketplaceListing } from "../marketplace/marketplace.js";

/** Minimal listing factory — only the fields the cover resolver reads. */
function listing(partial: Partial<MarketplaceListing>): MarketplaceListing {
  return {
    id: "lst_test",
    type: "skill",
    name: "Test Pack",
    slug: "test-pack",
    version: "1.0.0",
    author: "tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("coverForListing — pack cover resolution", () => {
  it("returns the bundled cover for each of the five shipped packs", () => {
    for (const slug of [
      "engineering",
      "gstack",
      "pocock-skills",
      "impeccable",
      "magicpath-agent-skills",
    ]) {
      const url = coverForListing(listing({ slug }));
      expect(typeof url).toBe("string");
      expect((url ?? "").length).toBeGreaterThan(0);
    }
  });

  it("every bundled-cover key resolves to a non-empty asset URL", () => {
    for (const [slug, url] of Object.entries(BUNDLED_PACK_COVERS)) {
      expect(url, `cover for ${slug}`).toBeTruthy();
    }
  });

  it("returns null for a pack with no bundled art and no hosted cover", () => {
    expect(coverForListing(listing({ slug: "some-unknown-pack" }))).toBeNull();
  });

  it("does not render an arbitrary remote cover URL (tracking-pixel contract)", () => {
    const hosted = "https://cdn.example.com/cover.png";
    expect(
      coverForListing(
        listing({ slug: "some-unknown-pack", coverImageUrl: hosted }),
      ),
    ).toBeNull();
  });

  it("renders a presigned marketplace cover URL from the allowlisted assets host", () => {
    const hosted = `https://${MARKETPLACE_COVER_HOST}/listings/lst_X/cover.jpg?X-Amz-Signature=mock`;
    expect(
      coverForListing(
        listing({ slug: "some-unknown-pack", coverImageUrl: hosted }),
      ),
    ).toBe(hosted);
  });

  it("prefers the marketplace cover over bundled-by-slug art", () => {
    const hosted = `https://${MARKETPLACE_COVER_HOST}/listings/lst_gstack/cover.png?X-Amz-Signature=mock`;
    expect(
      coverForListing(listing({ slug: "gstack", coverImageUrl: hosted })),
    ).toBe(hosted);
  });

  it("keeps bundled art when a listing also includes a blocked remote cover", () => {
    const url = coverForListing(
      listing({
        slug: "gstack",
        coverImageUrl: "https://cdn.example.com/cover.png",
      }),
    );
    expect(url).toBe(BUNDLED_PACK_COVERS.gstack);
  });

  it("accepts a raster data cover once a native proxy supplies one", () => {
    const proxied = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
    expect(
      coverForListing(
        listing({ slug: "some-unknown-pack", coverImageUrl: proxied }),
      ),
    ).toBe(proxied);
  });

  it("ignores a blank/whitespace coverImageUrl and falls back to bundled art", () => {
    const url = coverForListing(
      listing({ slug: "gstack", coverImageUrl: "   " }),
    );
    expect(url).not.toBe("   ");
    expect((url ?? "").length).toBeGreaterThan(0);
  });

  it("ignores a null coverImageUrl and falls back to bundled art", () => {
    const url = coverForListing(
      listing({ slug: "impeccable", coverImageUrl: null }),
    );
    expect((url ?? "").length).toBeGreaterThan(0);
  });
});

describe("coverFallback — deterministic branded placeholder", () => {
  it("derives a stable gradient + monogram from the slug", () => {
    const a = coverFallback(listing({ slug: "foo-bar", name: "Foo Bar" }));
    const b = coverFallback(listing({ slug: "foo-bar", name: "Foo Bar" }));
    expect(a.gradient).toBe(b.gradient);
    expect(a.gradient).toMatch(/^linear-gradient\(/);
    expect(a.monogram).toBe("F");
  });

  it("gives different slugs different gradients (no single flat color)", () => {
    const a = coverFallback(listing({ slug: "alpha" }));
    const b = coverFallback(listing({ slug: "zulu" }));
    expect(a.gradient).not.toBe(b.gradient);
  });

  it("uses neutral desktop tokens instead of arbitrary generated hues", () => {
    const fallback = coverFallback(listing({ slug: "community-pack" }));
    expect(fallback.gradient).toContain("var(--v4-text-2)");
    expect(fallback.gradient).toContain("var(--v4-ground)");
    expect(fallback.gradient).not.toMatch(/hsla?\(|#[0-9a-f]{3,8}/i);
  });

  it("falls back to a placeholder monogram when name and slug are empty", () => {
    const fb = coverFallback(listing({ slug: "", name: "" }));
    expect(fb.monogram).toBe("?");
    expect(fb.gradient).toMatch(/^linear-gradient\(/);
  });
});

describe("marketplaceCoverSrc — allowlisted marketplace assets host", () => {
  const valid = `https://${MARKETPLACE_COVER_HOST}/listings/lst_1/cover.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`;

  it("accepts a https listing cover on the production assets host", () => {
    expect(marketplaceCoverSrc(valid)).toBe(valid);
  });

  it("rejects http, wrong hosts, credentialed URLs, and non-listing paths", () => {
    for (const source of [
      valid.replace("https://", "http://"),
      "https://cdn.example.com/listings/lst_1/cover.jpg",
      `https://evil.${MARKETPLACE_COVER_HOST}/listings/lst_1/cover.jpg`,
      `https://user:pass@${MARKETPLACE_COVER_HOST}/listings/lst_1/cover.jpg`,
      `https://${MARKETPLACE_COVER_HOST}/creators/alice/avatar`,
      "not a url",
      "   ",
      null,
    ]) {
      expect(marketplaceCoverSrc(source), String(source)).toBeNull();
    }
  });
});

describe("coverTone — stable marketplace color identity", () => {
  it("returns one of the six supported tones and stays stable for a slug", () => {
    const a = coverTone(listing({ slug: "impeccable" }));
    const b = coverTone(listing({ slug: "impeccable", name: "Renamed pack" }));

    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(6);
  });

  it("does not collapse every listing onto one palette", () => {
    const tones = new Set(
      ["engineering", "gstack", "impeccable", "magicpath-agent-skills"].map(
        (slug) => coverTone(listing({ slug })),
      ),
    );

    expect(tones.size).toBeGreaterThan(1);
  });
});
