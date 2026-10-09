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
  OFFLOAD_CURRENT_COPY,
  cloudFileErrorCopy,
  cloudFileToast,
  cloudFileToastKey,
  offloadCandidates,
  offloadErrorsCopy,
  offloadFreedBytes,
  offloadOutcome,
  offloadPreviewBlocker,
  offloadSummary,
} from "./storage-model.js";

// Real `hq storage ... --json` output, captured from hq-cli feat/hq-storage
// against a fixture HQ (6 old copies of big files, 378,535,936 bytes).
import statusJson from "./__fixtures__/storage/status.json";
import statusAfterJson from "./__fixtures__/storage/status-after-offload.json";
import dryRunJson from "./__fixtures__/storage/offload-dry.json";
import realJson from "./__fixtures__/storage/offload-real.json";

const STATUS = statusJson as StorageStatus;
const STATUS_AFTER = statusAfterJson as StorageStatus;
const DRY_RUN = dryRunJson as StorageOffloadResult;
/** Uploaded 6 copies, then the history rewrite failed: freed 0, one error. */
const REAL_PARTIAL = realJson as StorageOffloadResult;

const CANDIDATE_BYTES = 378_535_936;
const MB = 1024 * 1024;

/** The CLI always marks current files blocked today. */
const CURRENT_BLOCKED = {
  available: false,
  reason: "Offloading current files is not available yet: HQ sync would treat the replaced file as deleted.",
};

/** The real dry run with the current-files block the CLI sends. */
const DRY_RUN_BLOCKED: StorageOffloadResult = {
  ...DRY_RUN,
  current: { ...DRY_RUN.current, ...CURRENT_BLOCKED },
};

/** The real status plus idle current files the CLI can't move yet. */
const STATUS_WITH_IDLE: StorageStatus = {
  ...STATUS,
  offload: {
    ...STATUS.offload!,
    current_candidates: { count: 3, bytes: 900 * MB },
    placeholders: { count: 2, bytes: 1000 * MB },
  },
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll("[data-testid='confirm-dialog']").forEach((n) => n.remove());
});

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
  it("is the first section and counts only what the CLI will move", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_WITH_IDLE }) });
    const section = q("settings-storage-big-files")!;
    const local = Array.from(host.querySelectorAll(".set-subhead")).find((n) =>
      n.textContent?.includes("Local backup history"),
    )!;
    expect(section.compareDocumentPosition(local) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 900 MB of idle current files are left out: the CLI can't move them yet.
    expect(q("settings-storage-big-files-total")?.textContent).toContain("361.0 MB in big files");
    expect(q("settings-storage-big-files-breakdown")?.textContent).toContain("6 old copies in backup history (361.0 MB)");
    expect(host.textContent).not.toContain("idle files in your HQ folder");
    const copy = q("settings-storage-big-files-copy")?.textContent ?? "";
    expect(copy).toContain(OFFLOAD_CONFIRM_COPY);
    expect(copy).not.toContain("still show in your HQ folder");
    expect(q("settings-storage-placeholders")?.textContent).toContain("2 files are already in HQ cloud (1000.0 MB).");
    const button = q("settings-storage-offload") as HTMLButtonElement;
    expect(button.textContent).toContain("Move to cloud and free ~361.0 MB");
    expect(button.disabled).toBe(false);
    expect(button.className).toContain("primary");
  });

  it("lists current files only once the CLI says it can move them", async () => {
    const value: StorageStatus = {
      ...STATUS_WITH_IDLE,
      offload: { ...STATUS_WITH_IDLE.offload!, current_available: true },
    };
    await render({ status: async () => ({ ok: true, value }) });
    expect(q("settings-storage-big-files-breakdown")?.textContent).toContain("3 idle files in your HQ folder (900.0 MB)");
    expect(q("settings-storage-big-files-copy")?.textContent).toContain(OFFLOAD_CURRENT_COPY);
    expect(q("settings-storage-offload")?.textContent).toContain("free ~1.23 GB");
  });

  it("shows a plain not-available state when status says offload can't run", async () => {
    const value: StorageStatus = {
      ...STATUS,
      offload: { ...STATUS.offload!, available: false, reason: "update HQ sync" },
    };
    await render({ status: async () => ({ ok: true, value }) });
    expect(q("settings-storage-big-files-unavailable")?.textContent).toContain("Update HQ to move big files to the cloud.");
    expect(q("settings-storage-offload")).toBeNull();
  });

  it("asks for an HQ update when status has no offload data", async () => {
    const { offload: _drop, ...noOffload } = STATUS;
    await render({ status: async () => ({ ok: true, value: noOffload as StorageStatus }) });
    expect(q("settings-storage-big-files-update")?.textContent).toContain("Update HQ to move big files");
    expect(q("settings-storage-offload")).toBeNull();
  });

  it("disables the action when there is nothing big to move", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_AFTER }) });
    expect(q("settings-storage-big-files-total")?.textContent).toContain("No big files to move");
    expect((q("settings-storage-offload") as HTMLButtonElement).disabled).toBe(true);
    expect(q("settings-storage-placeholders")).toBeNull();
  });

  it("previews from the real dry run, confirms in plain words, moves and refreshes", async () => {
    const previewOffload = vi.fn(async (): Promise<AdapterResult<StorageOffloadResult>> => ({ ok: true, value: DRY_RUN_BLOCKED }));
    let release!: () => void;
    const offload = vi.fn(
      () =>
        new Promise<AdapterResult<StorageOffloadResult>>((resolve) => {
          release = () =>
            resolve({
              ok: true,
              value: {
                ...REAL_PARTIAL,
                history: { ...REAL_PARTIAL.history, freed_bytes: 365 * MB },
                current: { ...REAL_PARTIAL.current, ...CURRENT_BLOCKED },
                errors: [],
              },
            });
        }),
    );
    const status = vi.fn(async () => ({ ok: true as const, value: STATUS }));
    await render({ status, previewOffload, offload });

    q("settings-storage-offload")!.click();
    await settle();
    expect(previewOffload).toHaveBeenCalledTimes(1);
    expect(offload).not.toHaveBeenCalled();
    const text = dialog()?.textContent ?? "";
    expect(text).toContain("Move big files to HQ cloud?");
    expect(text).toContain("6 old copies of big files in your backup history.");
    expect(text).not.toContain("haven't opened");
    expect(text).toContain("This frees about 361.0 MB");
    expect(text).toContain(OFFLOAD_CONFIRM_COPY);
    expect(text).not.toContain(OFFLOAD_CURRENT_COPY);

    dialogButton("Move to cloud").click();
    await settle();
    expect(offload).toHaveBeenCalledTimes(1);
    expect(q("settings-storage-offloading")?.textContent).toContain("Uploading and checking each file");
    expect((q("settings-storage-offload") as HTMLButtonElement).textContent).toContain("Moving…");
    expect((q("settings-storage-delete") as HTMLButtonElement).disabled).toBe(true);

    release();
    await settle();
    expect(q("settings-storage-offload-result")?.textContent).toContain("Moved to HQ cloud. Freed 365.0 MB.");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("reports the real partial failure plainly, never as success", async () => {
    await render({
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({ ok: true, value: DRY_RUN }),
      offload: async () => ({ ok: true, value: REAL_PARTIAL }),
    });
    q("settings-storage-offload")!.click();
    await settle();
    dialogButton("Move to cloud").click();
    await settle();
    const result = q("settings-storage-offload-result")!;
    expect(result.getAttribute("role")).toBe("alert");
    expect(result.textContent).toContain("No space was freed yet.");
    expect(result.textContent).toContain("Update HQ, then try again.");
    expect(result.textContent).not.toContain("Moved to HQ cloud");
    expect(result.textContent).not.toContain("history rewrite");
  });

  it("says not available, not 'Freed 0 B', when history can't move", async () => {
    const blocked: StorageOffloadResult = {
      history: { uploaded: 0, bytes: 0, freed_bytes: 0, available: false, reason: "update HQ" },
      current: { offloaded: [], freed_bytes: 0, ...CURRENT_BLOCKED },
      errors: [],
      dry_run: false,
    };
    await render({
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({ ok: true, value: DRY_RUN_BLOCKED }),
      offload: async () => ({ ok: true, value: blocked }),
    });
    q("settings-storage-offload")!.click();
    await settle();
    dialogButton("Move to cloud").click();
    await settle();
    const text = q("settings-storage-offload-result")?.textContent ?? "";
    expect(text).toContain("Update HQ to move big files to the cloud.");
    expect(text).not.toContain("Freed");
  });

  it("stops at the preview when the dry run says history can't move", async () => {
    await render({
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({
        ok: true,
        value: { ...DRY_RUN_BLOCKED, history: { uploaded: 0, bytes: 0, freed_bytes: 0, available: false, reason: "core script failed" } },
      }),
    });
    q("settings-storage-offload")!.click();
    await settle();
    expect(dialog()).toBeNull();
    expect(q("settings-storage-offload-error")?.textContent).toBe("Moving big files to the cloud isn't available yet.");
  });

  it("cancelling the confirm moves nothing", async () => {
    const offload = vi.fn();
    await render({
      status: async () => ({ ok: true, value: STATUS }),
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
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({ ok: false, message: "update-hq" }) as AdapterResult<StorageOffloadResult>,
    });
    q("settings-storage-offload")!.click();
    await settle();
    expect(dialog()).toBeNull();
    expect(q("settings-storage-offload-error")?.textContent).toBe("Update HQ to move big files to the cloud.");
  });

  it("says nothing was removed when the move fails", async () => {
    await render({
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({ ok: true, value: DRY_RUN }),
      offload: async () => ({ ok: false, message: "hq storage failed: S3 503" }) as AdapterResult<StorageOffloadResult>,
    });
    q("settings-storage-offload")!.click();
    await settle();
    dialogButton("Move to cloud").click();
    await settle();
    const err = q("settings-storage-offload-error")?.textContent ?? "";
    expect(err).toMatch(/Nothing was removed from this (Mac|PC|computer)/);
    expect(err).not.toContain("503");
  });

  it("tells the person when the preview finds nothing to move", async () => {
    await render({
      status: async () => ({ ok: true, value: STATUS }),
      previewOffload: async () => ({
        ok: true,
        value: { ...DRY_RUN, history: { uploaded: 0, bytes: 0, freed_bytes: 0, candidates: 0, candidate_bytes: 0 } },
      }),
    });
    q("settings-storage-offload")!.click();
    await settle();
    expect(dialog()).toBeNull();
    expect(q("settings-storage-offload-error")?.textContent).toBe("Nothing to move right now.");
  });
});

describe("Big files model", () => {
  it("counts history copies; current files only when the CLI can move them", () => {
    expect(offloadCandidates(STATUS.offload)).toEqual({ count: 6, bytes: CANDIDATE_BYTES });
    expect(offloadCandidates(STATUS_WITH_IDLE.offload)).toEqual({ count: 6, bytes: CANDIDATE_BYTES });
    expect(offloadCandidates({ ...STATUS_WITH_IDLE.offload!, current_available: true })).toEqual({
      count: 9,
      bytes: CANDIDATE_BYTES + 900 * MB,
    });
    expect(offloadCandidates({ ...STATUS.offload!, available: false })).toEqual({ count: 0, bytes: 0 });
    expect(offloadCandidates(null)).toEqual({ count: 0, bytes: 0 });
  });

  it("reads the real dry run's candidates, not its zero upload counts", () => {
    expect(DRY_RUN.history.uploaded).toBe(0);
    expect(offloadSummary(DRY_RUN)).toBe("6 old copies of big files in your backup history");
    expect(offloadFreedBytes(DRY_RUN)).toBe(CANDIDATE_BYTES);
    expect(offloadPreviewBlocker(DRY_RUN)).toBeNull();
    // Contract dry run (newer CLI) fills uploaded/bytes too: same answer.
    const filled = { ...DRY_RUN, history: { ...DRY_RUN.history, uploaded: 6, bytes: CANDIDATE_BYTES, freed_bytes: CANDIDATE_BYTES } };
    expect(offloadSummary(filled)).toBe(offloadSummary(DRY_RUN));
    expect(offloadFreedBytes(filled)).toBe(CANDIDATE_BYTES);
    // Older dry run without candidates falls back to bytes.
    const legacy = { ...filled, history: { uploaded: 6, bytes: CANDIDATE_BYTES, freed_bytes: 0 } };
    expect(offloadFreedBytes(legacy)).toBe(CANDIDATE_BYTES);
  });

  it("ignores current files the CLI marks unavailable", () => {
    const withCurrent: StorageOffloadResult = {
      ...DRY_RUN_BLOCKED,
      current: { ...DRY_RUN_BLOCKED.current, offloaded: [{ path: "a.mov", bytes: 500 * MB }] },
    };
    expect(offloadSummary(withCurrent)).toBe("6 old copies of big files in your backup history");
    expect(offloadFreedBytes(withCurrent)).toBe(CANDIDATE_BYTES);
  });

  it("only counts real freed bytes after a real run", () => {
    expect(offloadFreedBytes(REAL_PARTIAL)).toBe(0);
    expect(offloadOutcome(REAL_PARTIAL, "this Mac")).toEqual({
      ok: false,
      lines: ["No space was freed yet. Your files are still on this Mac.", "Update HQ, then try again."],
    });
    const someFreed = { ...REAL_PARTIAL, history: { ...REAL_PARTIAL.history, freed_bytes: 100 * MB } };
    expect(offloadOutcome(someFreed, "this PC")).toEqual({
      ok: false,
      lines: ["Moved some files to HQ cloud. Freed 100.0 MB.", "1 file couldn't be moved. It's still on this PC."],
    });
    expect(offloadOutcome({ ...someFreed, errors: [] }, "this PC")).toEqual({
      ok: true,
      lines: ["Moved to HQ cloud. Freed 100.0 MB."],
    });
  });

  it("uses the platform's name for the computer", () => {
    expect(offloadErrorsCopy(DRY_RUN)).toBe("");
    expect(offloadErrorsCopy({ ...DRY_RUN, errors: [1, 2] }, "this PC")).toBe("2 files couldn't be moved. They're still on this PC.");
    expect(cloudFileErrorCopy("open-failed", "this computer")).toBe("It downloaded, but no app on this computer could open it.");
  });

  it("maps every placeholder-open step to a toast without raw errors", () => {
    expect(cloudFileToast({ name: "promo.mp4", phase: "fetching" })).toMatchObject({
      title: "Downloading promo.mp4",
      progress: "indeterminate",
      sticky: true,
    });
    expect(cloudFileToast({ name: "promo.mp4", phase: "opened" }, "this Mac")).toMatchObject({
      tone: "ok",
      sticky: false,
      detail: "Opened it for you. It stays on this Mac while you use it.",
    });
    expect(cloudFileToast({ name: "promo.mp4", phase: "error", error: "offline" })).toMatchObject({
      title: "Couldn't open promo.mp4",
      tone: "err",
      detail: cloudFileErrorCopy("offline"),
    });
    expect(cloudFileErrorCopy("no-access")).toContain("don't have access");
    expect(cloudFileErrorCopy("update-hq")).toBe("Update HQ to open files stored in HQ cloud.");
    expect(cloudFileErrorCopy("AccessDenied: s3://bucket/key")).toBe("We couldn't download it. Try again in a moment.");
  });

  it("keys toasts by full path so same-named files stay apart", () => {
    const a = cloudFileToastKey({ name: "promo.mp4", path: "/HQ/a/promo.mp4.hqcloud", phase: "fetching" });
    const b = cloudFileToastKey({ name: "promo.mp4", path: "/HQ/b/promo.mp4.hqcloud", phase: "fetching" });
    expect(a).not.toBe(b);
    expect(cloudFileToastKey({ name: "promo.mp4", phase: "fetching" })).toBe("cloud-file:promo.mp4");
  });
});
