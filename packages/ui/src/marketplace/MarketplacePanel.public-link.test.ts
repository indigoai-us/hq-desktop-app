// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import MarketplacePanel from "./MarketplacePanel.svelte";
import { setHostOpenUrl } from "../common/external-links.js";
import { listingPublicUrl } from "./marketplace.js";

const listing = {
  id: "listing-bfcm",
  type: "skill",
  name: "hq-pack-bfcm-retention",
  slug: "bfcm-retention",
  version: "1.0.0",
  author: { handle: "boringecom", displayName: "Boring Ecom" },
  summary: "BFCM retention flows",
};

const PUBLIC_URL = "https://hqforwork.com/packs/bfcm-retention";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  setHostOpenUrl(null);
  vi.restoreAllMocks();
});

function adapterWith(listings: unknown[]): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => false,
    marketplace: {
      listListings: vi.fn(async () => ok({ listings })),
    },
  } as unknown as PlatformAdapter;
}

async function openDetail(listings: unknown[]): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MarketplacePanel, {
    target: host,
    props: { adapter: adapterWith(listings) },
  });
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('[data-testid="marketplace-card"]')).not.toBeNull();
  });
  host.querySelector<HTMLElement>('[data-testid="marketplace-card"]')?.click();
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector(".detail-title")).not.toBeNull();
  });
}

describe("listingPublicUrl", () => {
  it("builds the hqforwork.com /packs/{slug} page", () => {
    expect(listingPublicUrl({ slug: "bfcm-retention" })).toBe(PUBLIC_URL);
  });

  it("trims and encodes the slug", () => {
    expect(listingPublicUrl({ slug: "  a b/c " })).toBe(
      "https://hqforwork.com/packs/a%20b%2Fc",
    );
  });

  it("returns null without a slug and never adds UTM tags", () => {
    expect(listingPublicUrl({ slug: "   " })).toBeNull();
    expect(listingPublicUrl({ slug: "x" })).not.toContain("utm_");
  });
});

describe("MarketplacePanel public page link", () => {
  it("renders the public link in the detail panel and opens it via the host opener", async () => {
    const opener = vi.fn();
    setHostOpenUrl(opener);
    await openDetail([listing]);

    const link = host.querySelector<HTMLAnchorElement>(
      '[data-testid="marketplace-public-link-open"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe(PUBLIC_URL);
    expect(link?.textContent).toContain("View public page");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(opener).toHaveBeenCalledExactlyOnceWith(PUBLIC_URL);
  });

  it("copies the clean canonical URL and confirms", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await openDetail([listing]);

    host.querySelector<HTMLButtonElement>(
      '[data-testid="marketplace-public-link-copy"]',
    )?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(
        host.querySelector('[data-testid="marketplace-public-link-copy"]')?.textContent,
      ).toContain("Copied");
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(PUBLIC_URL);
  });
});
