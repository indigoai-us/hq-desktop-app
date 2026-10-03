// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { failure, ok, unavailable, type PlatformAdapter } from "@hq/platform";
import MarketplacePanel from "./MarketplacePanel.svelte";
import type { MarketplaceInstallEvents } from "./MarketplacePanel.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

const listing = {
  id: "lst_1",
  type: "skill",
  name: "Demo Pack",
  slug: "demo-pack",
  version: "1.0.0",
  author: { handle: "corey", displayName: "Corey" },
  status: "approved",
};

function adapterWith(installPack: () => Promise<unknown>): PlatformAdapter {
  const known: Record<string, unknown> = {
    listListings: vi.fn(async () => ok({ listings: [listing] })),
    installPack: vi.fn(installPack),
    recordInstall: vi.fn(async () => ok(null)),
  };
  const marketplace = new Proxy(known, {
    get: (target, key: string) => target[key] ?? (async () => unavailable()),
  });
  return {
    kind: "desktop",
    isAvailable: (cap: string) => cap === "canInstallLocally",
    marketplace,
    sync: { listSyncableWorkspaces: vi.fn(async () => unavailable()) },
    shell: { openUrl: vi.fn(async () => ok(null)) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function openAndInstall(adapter: PlatformAdapter, installEvents: MarketplaceInstallEvents | null = null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MarketplacePanel, { target: host, props: { adapter, installEvents } });
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('[data-testid="marketplace-card"]')).not.toBeNull();
  }, { timeout: 3000 });
  host.querySelector<HTMLElement>('[data-testid="marketplace-card"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(host.querySelector('[data-testid="marketplace-install-button"]')).not.toBeNull();
  });
  host.querySelector<HTMLButtonElement>('[data-testid="marketplace-install-button"]')!.click();
}

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

describe("MarketplacePanel raw errors (AUDIT-3c)", () => {
  it("install failure result shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await openAndInstall(adapterWith(async () => failure("http-500", RAW)));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-install-result"]')?.textContent).toContain(
        "Couldn't install this pack. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] install failed", RAW);
  });

  it("streamed install error shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fire: ((m: string) => void) | null = null;
    const events: MarketplaceInstallEvents = {
      subscribe: vi.fn(async (h) => {
        fire = h.onError;
        return () => {};
      }),
    };
    await openAndInstall(adapterWith(() => new Promise(() => {})), events);
    await vi.waitFor(() => expect(fire).not.toBeNull());
    fire!(RAW);
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-install-result"]')?.textContent).toContain(
        "Couldn't install this pack. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] install failed", RAW);
  });
});

describe("MarketplacePanel failed listings read", () => {
  it("shows the failure without a zero listing or available count", async () => {
    const adapter = adapterWith(async () => ok(null));
    (adapter.marketplace as unknown as Record<string, unknown>).listListings = vi.fn(async () => failure("network", RAW));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(MarketplacePanel, { target: host, props: { adapter } });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-error"]')).not.toBeNull();
    }, { timeout: 3000 });
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/\b0 listings\b/);
    expect(text).not.toMatch(/\b0 available\b/);
    expect(host.querySelector('[data-testid="marketplace-available"]')).toBeNull();
  });
});
