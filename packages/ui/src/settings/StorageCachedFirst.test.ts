// @vitest-environment happy-dom

// Settings › Storage opens on the host's last known figures while the slow
// `hq storage status` runs, and re-opening joins that read (no second scan).

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { AdapterResult, PlatformAdapter, StorageStatus } from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import statusJson from "./__fixtures__/storage/status-r3.json";

const GB = 1024 * 1024 * 1024;
/** Real CLI status shape (round-3 capture) with a known backup total. */
const SAMPLE_STATUS: StorageStatus = {
  ...(statusJson as unknown as StorageStatus),
  local: { ...(statusJson as unknown as StorageStatus).local, available: true, git_dir_bytes: 76.3 * GB },
};
const mounted: { host: HTMLElement; component: ReturnType<typeof mount> }[] = [];

afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await unmount(m.component);
    m.host.remove();
  }
});

type StorageMock = NonNullable<PlatformAdapter["storage"]>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function render(storage: Partial<StorageMock>, props: Record<string, unknown> = {}): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const adapter = { isAvailable: () => false, storage } as unknown as PlatformAdapter;
  const component = mount(StorageSettingsPane, { target: host, props: { adapter, ...props } });
  mounted.push({ host, component });
  await settle();
  return host;
}

const q = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

const CACHED: StorageStatus = {
  ...SAMPLE_STATUS,
  local: { ...SAMPLE_STATUS.local, git_dir_bytes: 50 * GB },
};

describe("Settings › Storage cached-first", () => {
  it("shows the cached figures and their age at once, then refreshes in place", async () => {
    const fresh = deferred<AdapterResult<StorageStatus>>();
    const fetchedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const host = await render({
      status: () => fresh.promise,
      cachedStatus: async () => ({ ok: true, value: { status: CACHED, fetched_at: fetchedAt, hq_root: "/hq" } }),
    });
    expect(q(host, "settings-storage-loading")).toBeNull();
    expect(q(host, "settings-storage-total")?.textContent).toContain("50.00 GB");
    expect(q(host, "settings-storage-age")?.textContent).toContain("Figures from 20 min ago.");
    expect(q(host, "settings-storage-age")?.textContent).toContain("Checking for changes…");
    expect(q(host, "settings-storage-refresh")?.getAttribute("aria-busy")).toBe("true");

    fresh.resolve({ ok: true, value: SAMPLE_STATUS });
    await settle();
    expect(q(host, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(q(host, "settings-storage-age")).toBeNull();
    expect(q(host, "settings-storage-refresh")?.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the cached figures when the refresh fails, and says so", async () => {
    const host = await render({
      status: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { ok: false, reason: "error", message: "storage-timeout" };
      },
      cachedStatus: async () => ({
        ok: true,
        value: { status: CACHED, fetched_at: new Date().toISOString(), hq_root: "/hq" },
      }),
    });
    await vi.waitFor(() => expect(q(host, "settings-storage-age")?.textContent).toContain("Couldn't check for changes."));
    expect(q(host, "settings-storage-total")?.textContent).toContain("50.00 GB");
    expect(q(host, "settings-storage-error")).toBeNull();
  });

  it("a fresh result that lands first is not replaced by the cache", async () => {
    const cached = deferred<AdapterResult<{ status: StorageStatus; fetched_at: string; hq_root: string } | null>>();
    const host = await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      cachedStatus: () => cached.promise,
    });
    cached.resolve({ ok: true, value: { status: CACHED, fetched_at: new Date().toISOString(), hq_root: "/hq" } });
    await settle();
    expect(q(host, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(q(host, "settings-storage-age")).toBeNull();
  });

  it("without a cache, shows the loader as before", async () => {
    const host = await render({
      status: () => new Promise(() => {}),
      cachedStatus: async () => ({ ok: true, value: null }),
    });
    expect(q(host, "settings-storage-loading")).not.toBeNull();
  });

  it("fails closed: a feature_disabled refusal hides the cached figures", async () => {
    const onfeaturedisabled = vi.fn();
    const host = await render(
      {
        status: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { ok: false, reason: "error", message: "storage-feature-disabled" };
        },
        cachedStatus: async () => ({
          ok: true,
          value: { status: CACHED, fetched_at: new Date().toISOString(), hq_root: "/hq" },
        }),
      },
      { onfeaturedisabled },
    );
    await vi.waitFor(() => expect(onfeaturedisabled).toHaveBeenCalled());
    await settle();
    expect(q(host, "settings-storage-total")).toBeNull();
    expect(q(host, "settings-storage-header")).toBeNull();
  });

  it("re-opening the screen joins the running read instead of starting another", async () => {
    const fresh = deferred<AdapterResult<StorageStatus>>();
    const status = vi.fn(() => fresh.promise);
    const storage: Partial<StorageMock> = { status };
    // Open, leave, open again, and a second copy rendering at the same time.
    const first = await render(storage);
    const m = mounted.shift()!;
    await unmount(m.component);
    m.host.remove();
    expect(first.isConnected).toBe(false);
    const again = await render(storage);
    const twin = await render(storage);
    expect(status).toHaveBeenCalledTimes(1);

    fresh.resolve({ ok: true, value: SAMPLE_STATUS });
    await settle();
    expect(q(again, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(q(twin, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(status).toHaveBeenCalledTimes(1);
  });
});
