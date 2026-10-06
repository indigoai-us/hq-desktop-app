// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import MarketplacePanel from "./MarketplacePanel.svelte";

const listing = {
  id: "listing-test",
  type: "skill",
  name: "hq-test-pack",
  slug: "test-pack",
  version: "1.0.0",
  author: { handle: "test-author", displayName: "Test Author" },
  summary: "A test pack",
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("MarketplacePanel install metrics fallback", () => {
  it("logs metrics failure while preserving the successful pack install result", async () => {
    const recordInstall = vi.fn(async () =>
      failure("http-503", "private response body detail"),
    );
    const installPack = vi.fn(async () => ok({}));
    const adapter = {
      kind: "desktop",
      isAvailable: (capability: string) => capability === "canInstallLocally",
      marketplace: {
        listListings: vi.fn(async () => ok({ listings: [listing] })),
        installPack,
        recordInstall,
      },
    } as unknown as PlatformAdapter;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MarketplacePanel, {
      target: host,
      props: { adapter },
    });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-card"]')).not.toBeNull();
    });
    host.querySelector<HTMLElement>('[data-testid="marketplace-card"]')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-install-button"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>(
      '[data-testid="marketplace-install-button"]',
    )?.click();

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-install-result"]')?.textContent)
        .toContain("Installed.");
      expect(warn).toHaveBeenCalledOnce();
    });

    expect(installPack).toHaveBeenCalledOnce();
    expect(recordInstall).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="marketplace-install-result"]')?.classList)
      .toContain("ok");
    expect(warn).toHaveBeenCalledWith(
      "[hq-ui-marketplace] install metrics failed",
      {
        name: "http-503",
        message: "Marketplace install metrics request failed",
      },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("listing-test");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private response body detail");
  });
});
