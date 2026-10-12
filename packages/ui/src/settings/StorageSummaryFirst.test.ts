// @vitest-environment happy-dom

// Settings › Storage shows the summary (`hq storage status --no-large`) as
// soon as it returns, then fills the big-file list from the separate
// `hq storage large` read. A first-ever open has no cache, so the slow
// big-file scan must not hold the summary back.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { AdapterResult, PlatformAdapter, StorageLarge, StorageStatus } from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import statusJson from "./__fixtures__/storage/status-r3.json";

const GB = 1024 * 1024 * 1024;
const FULL = statusJson as unknown as StorageStatus;
const SUMMARY: StorageStatus = {
  ...FULL,
  local: { ...FULL.local, available: true, git_dir_bytes: 76.3 * GB },
  offload: null,
};
const LARGE: StorageLarge = {
  offload: {
    history_candidates: { count: 3, bytes: 2 * GB },
    current_candidates: { count: 0, bytes: 0 },
    placeholders: { count: 0, bytes: 0 },
    current_available: false,
  },
  generated_at: "2026-10-12T00:00:00Z",
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

async function render(storage: Partial<StorageMock>): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const adapter = { isAvailable: () => false, storage } as unknown as PlatformAdapter;
  const component = mount(StorageSettingsPane, { target: host, props: { adapter } });
  mounted.push({ host, component });
  await settle();
  return host;
}

const q = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

describe("Settings › Storage summary first", () => {
  it("first open with no cache shows the summary before the big-file scan finishes", async () => {
    const large = deferred<AdapterResult<StorageLarge>>();
    const host = await render({
      status: async () => ({ ok: true, value: SUMMARY }),
      large: () => large.promise,
      cachedStatus: async () => ({ ok: true, value: null }),
    });
    expect(q(host, "settings-storage-loading")).toBeNull();
    expect(q(host, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(q(host, "settings-storage-big-files-loading")?.textContent).toContain("Checking for big files…");
    expect(q(host, "settings-storage-big-files-update")).toBeNull();

    large.resolve({ ok: true, value: LARGE });
    await settle();
    expect(q(host, "settings-storage-big-files-loading")).toBeNull();
    expect(host.textContent).toContain("2.00 GB in big files");
  });

  it("starts both reads at once, one each", async () => {
    const status = vi.fn(async () => ({ ok: true as const, value: SUMMARY }));
    const large = vi.fn(async () => ({ ok: true as const, value: LARGE }));
    await render({ status, large, cachedStatus: async () => ({ ok: true, value: null }) });
    expect(status).toHaveBeenCalledTimes(1);
    expect(large).toHaveBeenCalledTimes(1);
  });

  it("a big-file scan that beats the summary is kept", async () => {
    const summary = deferred<AdapterResult<StorageStatus>>();
    const host = await render({
      status: () => summary.promise,
      large: async () => ({ ok: true, value: LARGE }),
      cachedStatus: async () => ({ ok: true, value: null }),
    });
    summary.resolve({ ok: true, value: SUMMARY });
    await settle();
    expect(host.textContent).toContain("2.00 GB in big files");
  });

  it("a failed big-file scan leaves the summary and says to refresh", async () => {
    const host = await render({
      status: async () => ({ ok: true, value: SUMMARY }),
      large: async () => ({ ok: false, reason: "error", message: "storage-timeout" }),
      cachedStatus: async () => ({ ok: true, value: null }),
    });
    expect(q(host, "settings-storage-total")?.textContent).toContain("76.30 GB");
    expect(q(host, "settings-storage-big-files-error")?.textContent).toContain("Refresh to try again");
  });

  it("an older CLI without the big-file read still gets its full status", async () => {
    const host = await render({
      status: async () => ({ ok: true, value: { ...SUMMARY, offload: LARGE.offload } }),
      large: async () => ({ ok: false, reason: "error", message: "update-hq" }),
      cachedStatus: async () => ({ ok: true, value: null }),
    });
    expect(q(host, "settings-storage-big-files-error")).toBeNull();
    expect(host.textContent).toContain("2.00 GB in big files");
  });

  it("the big-file read refusing with feature_disabled hides Storage", async () => {
    const onfeaturedisabled = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const adapter = {
      isAvailable: () => false,
      storage: {
        status: () => new Promise(() => undefined),
        large: async () => ({ ok: false, reason: "error", message: "storage-feature-disabled" }),
      },
    } as unknown as PlatformAdapter;
    const component = mount(StorageSettingsPane, { target: host, props: { adapter, onfeaturedisabled } });
    mounted.push({ host, component });
    await settle();
    expect(onfeaturedisabled).toHaveBeenCalled();
  });
});
