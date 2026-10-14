// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { failure, ok, unavailable, type PlatformAdapter } from "@hq/platform";
import MarketplacePanel from "./MarketplacePanel.svelte";

// BLANK-2/3 regression: a failed listings read must not show a zero count
// beside the failed-read line, and a pending read offers Try again that
// starts a fresh read.

function adapterWith(listListings: () => Promise<unknown>): PlatformAdapter {
  const known: Record<string, unknown> = { listListings: vi.fn(listListings) };
  const marketplace = new Proxy(known, {
    get: (target, key: string) => target[key] ?? (async () => unavailable()),
  });
  return {
    kind: "desktop",
    isAvailable: () => false,
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
  vi.useRealTimers();
});

function render(adapter: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MarketplacePanel, { target: host, props: { adapter } });
}

describe("MarketplacePanel failed and pending reads", () => {
  it("shows no listing count beside the failed-read line", async () => {
    render(adapterWith(async () => failure("network", "boom")));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-error"]')).not.toBeNull();
    });
    const text = host.textContent ?? "";
    expect(text).not.toMatch(/\b0 listings\b/);
    expect(text).not.toMatch(/\b0 available\b/);
  });

  it("still shows the counts after a successful read", async () => {
    render(adapterWith(async () => ok({ listings: [] })));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="marketplace-empty"]')).not.toBeNull();
    });
    expect(host.textContent).toMatch(/0\s+listings/);
    expect(host.textContent).toMatch(/0 available/);
  });

  it("offers Try again on a long pending read and starts a fresh read", async () => {
    vi.useFakeTimers();
    const listListings = vi.fn(() => new Promise(() => {}));
    render(adapterWith(listListings));
    flushSync();
    expect(host.querySelector('[data-testid="marketplace-loading"]')).not.toBeNull();
    expect(listListings).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(61_000);
    flushSync();
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="marketplace-loading-retry"]');
    expect(retry).not.toBeNull();
    retry!.click();
    flushSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(listListings).toHaveBeenCalledTimes(2);
  });
});
