// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type {
  AdapterResult,
  PlatformAdapter,
  StoragePruneRequest,
  StoragePruneResult,
  StorageStatus,
} from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import ShellSettings from "./ShellSettings.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll("[data-testid='confirm-dialog']").forEach((n) => n.remove());
});

const GB = 1024 * 1024 * 1024;

export const SAMPLE_STATUS: StorageStatus = {
  local: {
    available: true,
    root: "/Users/me/HQ",
    git_dir_bytes: 76.3 * GB,
    working_tree_bytes: 4.2 * GB,
    commit_count: 5200,
    tranches: [
      { id: "7d", label: "Last 7 days", commit_count: 120, est_bytes: 0.4 * GB },
      { id: "30d", label: "7 to 30 days ago", commit_count: 400, est_bytes: 2 * GB },
      { id: "90d", label: "1 to 3 months ago", commit_count: 900, est_bytes: 9 * GB },
      { id: "365d", label: "3 to 12 months ago", commit_count: 2100, est_bytes: 30 * GB },
      { id: "older", label: "Older than a year", commit_count: 1680, est_bytes: 34.9 * GB },
    ],
  },
  cloud: [
    {
      company: "indigo",
      available: true,
      current_bytes: 3 * GB,
      noncurrent_bytes: 6 * GB,
      noncurrent_count: 18000,
      delete_markers: 420,
      tranches: [
        { id: "7d", label: "Last 7 days", count: 500, bytes: 0.2 * GB },
        { id: "30d", label: "7 to 30 days ago", count: 2500, bytes: 1 * GB },
        { id: "older", label: "Older than 30 days", count: 15000, bytes: 4.8 * GB },
      ],
    },
    {
      company: "acme",
      available: false,
      error: "AccessDenied",
      current_bytes: 0,
      noncurrent_bytes: 0,
      noncurrent_count: 0,
      delete_markers: 0,
      tranches: [],
    },
  ],
  generated_at: "2026-10-09T12:00:00Z",
};

type StorageMock = NonNullable<PlatformAdapter["storage"]>;

function adapter(storage: Partial<StorageMock> | null): PlatformAdapter {
  return {
    isAvailable: () => false,
    storage: storage ?? undefined,
  } as unknown as PlatformAdapter;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function render(storage: Partial<StorageMock> | null): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(StorageSettingsPane, {
    target: host,
    props: { adapter: adapter(storage) },
  });
  await settle();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

describe("Settings › Storage pane", () => {
  it("shows the loader while the status read is pending", async () => {
    await render({ status: () => new Promise(() => {}) });
    expect(q("settings-storage-loading")).not.toBeNull();
    expect(q("settings-storage-header")).toBeNull();
  });

  it("shows a plain error with Try again when the read fails", async () => {
    await render({
      status: async () => ({ ok: false, reason: "error", message: "hq storage failed: EIO" }),
    });
    const err = q("settings-storage-error");
    expect(err?.textContent).toContain("couldn't read your backup sizes");
    expect(err?.textContent).not.toContain("EIO");
    expect(err?.textContent).toContain("Try again");
  });

  it("asks for an HQ update when the CLI is missing or too old", async () => {
    await render({
      status: async () => ({ ok: false, reason: "error", message: "update-hq" }),
    });
    expect(q("settings-storage-error")?.textContent).toContain("Update HQ to manage storage.");
  });

  it("is unavailable on hosts without the storage group", async () => {
    await render(null);
    expect(q("settings-storage-unavailable")).not.toBeNull();
  });

  it("renders the totals, local bands and cloud companies", async () => {
    await render({ status: async () => ({ ok: true, value: SAMPLE_STATUS }) });
    expect(q("settings-storage-total")?.textContent).toContain("HQ backups on this Mac: 76.30 GB");
    expect(host.querySelectorAll("[data-testid='settings-storage-local-table'] tbody tr")).toHaveLength(5);
    expect((q("storage-local-band-7d") as HTMLInputElement).disabled).toBe(true);
    expect(q("settings-storage-cloud-indigo")?.textContent).toContain("420 deleted-file markers");
    expect(q("settings-storage-cloud-acme")?.textContent).toContain("couldn't read this company's file history");
    expect(q("settings-storage-free-up")?.textContent).toContain("Nothing selected");
  });

  it("explains when this Mac's HQ is too old for backup history", async () => {
    await render({
      status: async () => ({
        ok: true,
        value: {
          ...SAMPLE_STATUS,
          local: { ...SAMPLE_STATUS.local, available: false, reason: "too old", tranches: [] },
        },
      }),
    });
    expect(q("settings-storage-local-unavailable")).not.toBeNull();
  });

  it("checking a band cascades to older bands and updates Free up", async () => {
    await render({ status: async () => ({ ok: true, value: SAMPLE_STATUS }) });
    (q("storage-local-band-90d") as HTMLInputElement).click();
    await settle();
    expect((q("storage-local-band-365d") as HTMLInputElement).checked).toBe(true);
    expect((q("storage-local-band-older") as HTMLInputElement).checked).toBe(true);
    expect((q("storage-local-band-30d") as HTMLInputElement).checked).toBe(false);
    expect(q("settings-storage-free-up")?.textContent).toContain("Free up ~73.90 GB");
  });

  it("previews, requires confirm, deletes, and reports the result", async () => {
    const result = (freed: number, dry: boolean): AdapterResult<StoragePruneResult> => ({
      ok: true,
      value: { dry_run: dry, local: { freed_bytes: freed, commits_removed: 3 }, cloud: [] },
    });
    const previewPrune = vi.fn(async () => result(64 * GB, true));
    const prune = vi.fn(async (_req: StoragePruneRequest) => result(64 * GB, false));
    const status = vi.fn(async () => ({ ok: true as const, value: SAMPLE_STATUS }));
    await render({ status, previewPrune, prune });

    (q("storage-local-band-365d") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")?.click();
    await settle();

    expect(previewPrune).toHaveBeenCalledTimes(1);
    expect(prune).not.toHaveBeenCalled();
    const dialog = document.querySelector("[data-testid='confirm-dialog']");
    expect(dialog?.textContent).toContain("This can't be undone. You won't be able to restore these old versions.");
    expect(dialog?.textContent).toContain("64.00 GB");

    const confirm = Array.from(dialog!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete"),
    );
    confirm!.click();
    await settle();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]![0]).toHaveProperty("localBefore");
    expect(q("settings-storage-result")?.textContent).toContain("Freed 64.00 GB");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("cancelling the confirm deletes nothing", async () => {
    const prune = vi.fn();
    await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      previewPrune: async () => ({ ok: true, value: { dry_run: true, local: { freed_bytes: 1, commits_removed: 1 }, cloud: [] } }),
      prune,
    });
    (q("storage-local-band-older") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")?.click();
    await settle();
    const dialog = document.querySelector("[data-testid='confirm-dialog']");
    Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent?.includes("Cancel"))!.click();
    await settle();
    expect(prune).not.toHaveBeenCalled();
  });
});

describe("Settings › Storage in the settings list", () => {
  it("is a nav item when the host has the storage group", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ShellSettings, {
      target: host,
      props: { adapter: adapter({ status: () => new Promise(() => {}) }) },
    });
    await settle();
    const nav = q("settings-nav-storage") as HTMLButtonElement | null;
    expect(nav?.textContent).toContain("Storage");
    nav!.click();
    await settle();
    expect(q("settings-storage-pane")).not.toBeNull();
  });

  it("is hidden when the host cannot manage storage", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ShellSettings, { target: host, props: { adapter: adapter(null) } });
    await settle();
    expect(q("settings-nav-storage")).toBeNull();
  });
});
