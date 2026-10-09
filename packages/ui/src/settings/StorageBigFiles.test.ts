// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type {
  AdapterResult,
  PlatformAdapter,
  StorageOffloadResult,
  StorageStatus,
} from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import {
  OFFLOAD_CONFIRM_COPY,
  cloudFileErrorCopy,
  cloudFileToast,
  offloadCandidates,
  offloadErrorsCopy,
  offloadFreedBytes,
  offloadSummary,
} from "./storage-model.js";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll("[data-testid='confirm-dialog']").forEach((n) => n.remove());
});

const BASE: StorageStatus = {
  local: {
    available: true,
    git_dir_bytes: 76.3 * GB,
    working_tree_bytes: 4.2 * GB,
    commit_count: 10,
    tranches: [
      { id: "7d", label: "Last 7 days", commit_count: 1, est_bytes: 1 },
      { id: "older", label: "Older", commit_count: 9, est_bytes: 9 * GB },
    ],
  },
  cloud: [],
};

const WITH_OFFLOAD: StorageStatus = {
  ...BASE,
  offload: {
    history_candidates: { count: 660, bytes: 55.9 * GB },
    current_candidates: { count: 3, bytes: 900 * MB },
    placeholders: { count: 2, bytes: 1000 * MB },
  },
};

/** Contract shape of `hq storage offload --dry-run --json`. */
const DRY_RUN: StorageOffloadResult = {
  history: { uploaded: 660, bytes: 55.9 * GB, freed_bytes: 55 * GB },
  current: {
    offloaded: [
      { path: "companies/acme/media/promo.mp4", bytes: 500 * MB },
      { path: "personal/raw.mov", bytes: 400 * MB },
    ],
    freed_bytes: 900 * MB,
  },
  errors: [],
  dry_run: true,
};

type StorageMock = NonNullable<PlatformAdapter["storage"]>;

function adapter(storage: Partial<StorageMock>): PlatformAdapter {
  return { isAvailable: () => false, storage } as unknown as PlatformAdapter;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function render(storage: Partial<StorageMock>): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(StorageSettingsPane, { target: host, props: { adapter: adapter(storage) } });
  await settle();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);
const dialog = () => document.querySelector("[data-testid='confirm-dialog']");
const dialogButton = (label: string) =>
  Array.from(dialog()!.querySelectorAll("button")).find((b) => b.textContent?.includes(label))!;

describe("Settings › Storage › Big files", () => {
  it("is the first section, with total, breakdown, placeholders and the primary action", async () => {
    await render({ status: async () => ({ ok: true, value: WITH_OFFLOAD }) });
    const section = q("settings-storage-big-files")!;
    const local = Array.from(host.querySelectorAll(".set-subhead")).find((n) =>
      n.textContent?.includes("Local backup history"),
    )!;
    expect(section.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(q("settings-storage-big-files-total")?.textContent).toContain("56.78 GB in big files");
    expect(host.textContent).toContain("3 idle files in your HQ folder");
    expect(host.textContent).toContain("660 old copies in backup history");
    expect(q("settings-storage-placeholders")?.textContent).toContain("2 files are already in HQ cloud (1000.0 MB).");
    const button = q("settings-storage-offload") as HTMLButtonElement;
    expect(button.textContent).toContain("Move to cloud and free ~56.78 GB");
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("primary");
  });

  it("asks for an HQ update when status has no offload data", async () => {
    await render({ status: async () => ({ ok: true, value: BASE }) });
    expect(q("settings-storage-big-files-update")?.textContent).toContain("Update HQ to move big files");
    expect(q("settings-storage-offload")).toBeNull();
  });

  it("disables the action when there is nothing big to move", async () => {
    await render({
      status: async () => ({
        ok: true,
        value: {
          ...BASE,
          offload: {
            history_candidates: { count: 0, bytes: 0 },
            current_candidates: { count: 0, bytes: 0 },
            placeholders: { count: 0, bytes: 0 },
          },
        },
      }),
    });
    expect(q("settings-storage-big-files-total")?.textContent).toContain("No big files to move");
    expect((q("settings-storage-offload") as HTMLButtonElement).disabled).toBe(true);
    expect(q("settings-storage-placeholders")).toBeNull();
  });

  it("previews, confirms in plain words, moves, reports and refreshes", async () => {
    const previewOffload = vi.fn(async (): Promise<AdapterResult<StorageOffloadResult>> => ({ ok: true, value: DRY_RUN }));
    let release!: () => void;
    const offload = vi.fn(
      () =>
        new Promise<AdapterResult<StorageOffloadResult>>((resolve) => {
          release = () =>
            resolve({
              ok: true,
              value: { ...DRY_RUN, dry_run: false, errors: [{ path: "x.mov", message: "upload failed" }] },
            });
        }),
    );
    const status = vi.fn(async () => ({ ok: true as const, value: WITH_OFFLOAD }));
    await render({ status, previewOffload, offload });

    q("settings-storage-offload")!.click();
    await settle();
    expect(previewOffload).toHaveBeenCalledTimes(1);
    expect(offload).not.toHaveBeenCalled();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Move big files to HQ cloud?");
    expect(text).toContain("660 old copies of big files in your backup history and 2 big files you haven't opened in 14 days");
    expect(text).toContain("This frees about 55.88 GB");
    expect(text).toContain(OFFLOAD_CONFIRM_COPY);

    dialogButton("Move to cloud").click();
    await settle();
    expect(offload).toHaveBeenCalledTimes(1);
    expect(q("settings-storage-offloading")?.textContent).toContain("Uploading and checking each file");
    expect((q("settings-storage-offload") as HTMLButtonElement).textContent).toContain("Moving…");
    expect((q("settings-storage-delete") as HTMLButtonElement).disabled).toBe(true);

    release();
    await settle();
    expect(q("settings-storage-offload-result")?.textContent).toContain("Freed 55.88 GB");
    expect(q("settings-storage-offload-result")?.textContent).toContain("1 file couldn't be moved. It's still on this Mac.");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("cancelling the confirm moves nothing", async () => {
    const offload = vi.fn();
    await render({
      status: async () => ({ ok: true, value: WITH_OFFLOAD }),
      previewOffload: async () => ({ ok: true, value: DRY_RUN }),
      offload,
    });
    q("settings-storage-offload")!.click();
    await settle();
    dialogButton("Cancel").click();
    await settle();
    expect(offload).not.toHaveBeenCalled();
    expect((q("settings-storage-offload") as HTMLButtonElement).disabled).toBe(false);
  });

  it("says Update HQ when the CLI lacks offload, without raw errors", async () => {
    await render({
      status: async () => ({ ok: true, value: WITH_OFFLOAD }),
      previewOffload: async () => ({ ok: false, message: "update-hq" }) as AdapterResult<StorageOffloadResult>,
    });
    q("settings-storage-offload")!.click();
    await settle();
    expect(dialog()).toBeNull();
    expect(q("settings-storage-offload-error")?.textContent).toBe("Update HQ to move big files to the cloud.");
  });

  it("says nothing was removed when the move fails", async () => {
    await render({
      status: async () => ({ ok: true, value: WITH_OFFLOAD }),
      previewOffload: async () => ({ ok: true, value: DRY_RUN }),
      offload: async () => ({ ok: false, message: "hq storage failed: S3 503" }) as AdapterResult<StorageOffloadResult>,
    });
    q("settings-storage-offload")!.click();
    await settle();
    dialogButton("Move to cloud").click();
    await settle();
    const err = q("settings-storage-offload-error")?.textContent ?? "";
    expect(err).toContain("Nothing was removed from this Mac");
    expect(err).not.toContain("503");
  });

  it("tells the person when the preview finds nothing to move", async () => {
    await render({
      status: async () => ({ ok: true, value: WITH_OFFLOAD }),
      previewOffload: async () => ({
        ok: true,
        value: { history: { uploaded: 0, bytes: 0, freed_bytes: 0 }, current: { offloaded: [], freed_bytes: 0 }, errors: [], dry_run: true },
      }),
    });
    q("settings-storage-offload")!.click();
    await settle();
    expect(dialog()).toBeNull();
    expect(q("settings-storage-offload-error")?.textContent).toBe("Nothing to move right now.");
  });
});

describe("Big files model", () => {
  it("adds history and current candidates", () => {
    expect(offloadCandidates(WITH_OFFLOAD.offload)).toEqual({ count: 663, bytes: 55.9 * GB + 900 * MB });
    expect(offloadCandidates(null)).toEqual({ count: 0, bytes: 0 });
  });

  it("uses freed bytes, falling back to moved size on a dry run", () => {
    expect(offloadFreedBytes(DRY_RUN)).toBe(55 * GB + 900 * MB);
    const noEstimate = {
      ...DRY_RUN,
      history: { ...DRY_RUN.history, freed_bytes: 0 },
      current: { ...DRY_RUN.current, freed_bytes: 0 },
    };
    expect(offloadFreedBytes(noEstimate)).toBe(55.9 * GB + 900 * MB);
    expect(offloadFreedBytes({ ...noEstimate, dry_run: false })).toBe(0);
  });

  it("summarizes in plain words and pluralizes", () => {
    expect(offloadSummary({ ...DRY_RUN, history: { uploaded: 1, bytes: 1, freed_bytes: 1 }, current: { offloaded: [], freed_bytes: 0 } })).toBe(
      "1 old copy of big files in your backup history",
    );
    expect(offloadErrorsCopy(DRY_RUN)).toBe("");
    expect(offloadErrorsCopy({ ...DRY_RUN, errors: [1, 2] })).toBe("2 files couldn't be moved. They're still on this Mac.");
  });

  it("maps every placeholder-open step to a toast without raw errors", () => {
    expect(cloudFileToast({ name: "promo.mp4", phase: "fetching" })).toMatchObject({
      title: "Downloading promo.mp4",
      progress: "indeterminate",
      sticky: true,
    });
    expect(cloudFileToast({ name: "promo.mp4", phase: "opened" })).toMatchObject({ tone: "ok", sticky: false });
    expect(cloudFileToast({ name: "promo.mp4", phase: "error", error: "offline" })).toMatchObject({
      title: "Couldn't open promo.mp4",
      tone: "err",
      detail: cloudFileErrorCopy("offline"),
    });
    expect(cloudFileErrorCopy("no-access")).toContain("don't have access");
    expect(cloudFileErrorCopy("update-hq")).toBe("Update HQ to open files stored in HQ cloud.");
    expect(cloudFileErrorCopy("AccessDenied: s3://bucket/key")).toBe("We couldn't download it. Try again in a moment.");
  });
});
