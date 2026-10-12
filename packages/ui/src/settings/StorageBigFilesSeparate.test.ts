// @vitest-environment happy-dom

// Settings › Storage with a newer hq CLI: `hq storage status` leaves out the
// big-file scan and `hq storage big-files` runs it on its own. The summary
// renders first; Big files fill in later with their own loading state. An
// older CLI (no `big-files`, answers `update-hq`) keeps the single status call.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { AdapterResult, PlatformAdapter, StorageBigFiles, StorageStatus } from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import { bigFilesInFlight, joinBigFiles } from "./storage-load.js";
// hq-cli fix/storage-status-fast-default shapes (fixtures README, round 5).
import fastJson from "./__fixtures__/storage/status-fast-r5.json";
import bigFilesJson from "./__fixtures__/storage/big-files-r5.json";
// An older CLI's status: big files inline, no big_files_included.
import oldStatusJson from "./__fixtures__/storage/status-held-r4.json";

const FAST = fastJson as unknown as StorageStatus;
const BIG = bigFilesJson as unknown as StorageBigFiles;
const OLD = oldStatusJson as unknown as StorageStatus;

type StorageMock = NonNullable<PlatformAdapter["storage"]>;

const mounted: { host: HTMLElement; component: ReturnType<typeof mount> }[] = [];

afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await unmount(m.component);
    m.host.remove();
  }
  vi.restoreAllMocks();
});

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
const noCache = async () => ({ ok: true as const, value: null });
const OLD_CLI = { ok: false, reason: "error", message: "update-hq" } as AdapterResult<StorageBigFiles>;

describe("Settings › Storage: summary first, big files later", () => {
  it("first-ever open with no cache: the figures render before the big-file result", async () => {
    const big = deferred<AdapterResult<StorageBigFiles>>();
    const host = await render({
      status: async () => ({ ok: true, value: FAST }),
      bigFiles: () => big.promise,
      cachedStatus: noCache,
    });
    // Summary is up while the big-file scan is still running.
    expect(q(host, "settings-storage-loading")).toBeNull();
    expect(q(host, "settings-storage-total")?.textContent).toContain("HQ backups on");
    expect(q(host, "settings-storage-local-table")).not.toBeNull();
    expect(q(host, "settings-storage-big-files-loading")?.textContent).toContain("Checking for big files");
    expect(q(host, "settings-storage-big-files-total")).toBeNull();
    expect(q(host, "settings-storage-big-files-update")).toBeNull();

    big.resolve({ ok: true, value: BIG });
    await settle();
    expect(q(host, "settings-storage-big-files-loading")).toBeNull();
    expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
    expect(q(host, "settings-storage-history-held")).not.toBeNull();
  });

  it("starts each read once, and re-opening joins both instead of scanning again", async () => {
    const fresh = deferred<AdapterResult<StorageStatus>>();
    const big = deferred<AdapterResult<StorageBigFiles>>();
    const status = vi.fn(() => fresh.promise);
    const bigFiles = vi.fn(() => big.promise);
    const storage: Partial<StorageMock> = { status, bigFiles };
    await render(storage);
    const m = mounted.shift()!;
    await unmount(m.component);
    m.host.remove();
    const again = await render(storage);
    const twin = await render(storage);
    expect(status).toHaveBeenCalledTimes(1);
    expect(bigFiles).toHaveBeenCalledTimes(1);

    fresh.resolve({ ok: true, value: FAST });
    big.resolve({ ok: true, value: BIG });
    await settle();
    for (const host of [again, twin]) {
      expect(q(host, "settings-storage-total")).not.toBeNull();
      expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
    }
    expect(status).toHaveBeenCalledTimes(1);
    expect(bigFiles).toHaveBeenCalledTimes(1);
  });

  it("big files that land before the summary are kept", async () => {
    const fresh = deferred<AdapterResult<StorageStatus>>();
    const host = await render({
      status: () => fresh.promise,
      bigFiles: async () => ({ ok: true, value: BIG }),
      cachedStatus: noCache,
    });
    expect(q(host, "settings-storage-loading")).not.toBeNull();
    fresh.resolve({ ok: true, value: FAST });
    await settle();
    expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
  });

  it("a failed big-file read keeps the summary and says so in the section", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const host = await render({
      status: async () => ({ ok: true, value: FAST }),
      bigFiles: async () => ({ ok: false, reason: "error", message: "storage-timeout" }),
    });
    expect(q(host, "settings-storage-total")).not.toBeNull();
    expect(q(host, "settings-storage-error")).toBeNull();
    expect(q(host, "settings-storage-big-files-error")?.textContent).toContain("couldn't check for big files");
  });

  it("cached big files show at once while the fresh big-file read runs; Move waits for it", async () => {
    const big = deferred<AdapterResult<StorageBigFiles>>();
    const cachedStatus = { ...FAST, offload: BIG.offload };
    const host = await render({
      status: async () => ({ ok: true, value: FAST }),
      bigFiles: () => big.promise,
      cachedStatus: async () => ({
        ok: true,
        value: { status: cachedStatus, fetched_at: new Date().toISOString(), hq_root: "/hq" },
      }),
    });
    expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
    expect(q(host, "settings-storage-big-files-checking")).not.toBeNull();
    expect(q(host, "settings-storage-offload")?.hasAttribute("disabled")).toBe(true);

    big.resolve({ ok: true, value: BIG });
    await settle();
    expect(q(host, "settings-storage-big-files-checking")).toBeNull();
    expect(q(host, "settings-storage-offload")?.hasAttribute("disabled")).toBe(false);
  });

  it("feature_disabled from the big-file read hides Storage", async () => {
    const onfeaturedisabled = vi.fn();
    const host = await render(
      {
        status: () => new Promise(() => {}),
        bigFiles: async () => ({ ok: false, reason: "error", message: "storage-feature-disabled" }),
      },
      { onfeaturedisabled },
    );
    expect(onfeaturedisabled).toHaveBeenCalled();
    expect(q(host, "settings-storage-loading")).toBeNull();
    expect(q(host, "settings-storage-header")).toBeNull();
  });
});

describe("Settings › Storage with an older hq CLI (no `storage big-files`)", () => {
  it("falls back to big files from status without errors, and never asks again", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fresh = deferred<AdapterResult<StorageStatus>>();
    const status = vi.fn(() => fresh.promise);
    const bigFiles = vi.fn(async () => OLD_CLI);
    const host = await render({ status, bigFiles, cachedStatus: noCache });
    // The old single status call still runs the scan: the page waits as before.
    expect(q(host, "settings-storage-loading")).not.toBeNull();
    fresh.resolve({ ok: true, value: OLD });
    await settle();
    expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
    expect(q(host, "settings-storage-big-files-error")).toBeNull();
    expect(q(host, "settings-storage-big-files-update")).toBeNull();
    expect(q(host, "settings-storage-error")).toBeNull();
    expect(errors).not.toHaveBeenCalled();

    // Refresh re-reads status only; the missing command is not retried.
    status.mockImplementation(async () => ({ ok: true, value: OLD }));
    q(host, "settings-storage-refresh")!.click();
    await settle();
    expect(status).toHaveBeenCalledTimes(2);
    expect(bigFiles).toHaveBeenCalledTimes(1);
    expect(q(host, "settings-storage-big-files-total")).not.toBeNull();
  });

  it("a host without bigFiles behaves like an older CLI", async () => {
    const host = await render({ status: async () => ({ ok: true, value: OLD }) });
    expect(q(host, "settings-storage-big-files-total")?.textContent).toContain("in big files");
    expect(q(host, "settings-storage-big-files-loading")).toBeNull();
  });

  it("a CLI that predates big files entirely still says to update HQ", async () => {
    const { offload: _o, ...noOffload } = OLD;
    const host = await render({
      status: async () => ({ ok: true, value: noOffload as StorageStatus }),
      bigFiles: async () => OLD_CLI,
    });
    expect(q(host, "settings-storage-big-files-update")).not.toBeNull();
  });
});

describe("joinBigFiles", () => {
  it("joins a running read, and after a write waits for it and reads again", async () => {
    const first = deferred<AdapterResult<StorageBigFiles>>();
    let calls = 0;
    const api = {
      bigFiles: vi.fn(() => {
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve({ ok: true as const, value: BIG });
      }),
    } as unknown as StorageMock;
    const a = joinBigFiles(api);
    const b = joinBigFiles(api);
    expect(a).toBe(b);
    expect(bigFilesInFlight(api)).toBe(true);
    const after = joinBigFiles(api, { afterWrite: true });
    await settle();
    expect(api.bigFiles).toHaveBeenCalledTimes(1);
    first.resolve({ ok: true, value: { ...BIG, generated_at: "old" } });
    expect((await a).ok).toBe(true);
    const fresh = await after;
    expect(fresh.ok && fresh.value.generated_at).toBe(BIG.generated_at);
    expect(api.bigFiles).toHaveBeenCalledTimes(2);
    expect(bigFilesInFlight(api)).toBe(false);
  });

  it("answers update-hq for a host without bigFiles", async () => {
    const res = await joinBigFiles({} as StorageMock);
    expect(res).toMatchObject({ ok: false, message: "update-hq" });
  });
});
