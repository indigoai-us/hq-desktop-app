// @vitest-environment happy-dom

/**
 * Round 3: what the pane says after the core script's 24 h undo backup,
 * prune refusals and reclaim. Driven by real CLI JSON (round-2 e2e capture)
 * and the round-3 contract fixtures built from it (see __fixtures__/storage/README.md).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type {
  AdapterResult,
  PlatformAdapter,
  StorageOffloadResult,
  StoragePruneResult,
  StorageStatus,
} from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import {
  cloudFileErrorCopy,
  holderLabel,
  holdersCopy,
  localTime,
  offloadOutcome,
  pruneConfirmCopy,
  pruneHolders,
  pruneOutcome,
  prunedBytes,
} from "./storage-model.js";

import statusHoldersJson from "./__fixtures__/storage/status-holders.json";
import statusR3Json from "./__fixtures__/storage/status-r3.json";
import pruneDryHoldersJson from "./__fixtures__/storage/prune-dry-holders.json";
import pruneDryCleanJson from "./__fixtures__/storage/prune-dry-clean.json";
import pruneDryR3Json from "./__fixtures__/storage/prune-dry-r3.json";
import pruneRealCleanJson from "./__fixtures__/storage/prune-real-clean-backup.json";
import pruneRealR3Json from "./__fixtures__/storage/prune-real-r3.json";
import pruneRefusedR3Json from "./__fixtures__/storage/prune-refused-r3.json";
import pruneRefusedR2Json from "./__fixtures__/storage/prune-real-holders-r2.json";
import offloadBackupJson from "./__fixtures__/storage/offload-real-backup.json";
import offloadR3Json from "./__fixtures__/storage/offload-real-r3.json";

const STATUS_HOLDERS = statusHoldersJson as unknown as StorageStatus;
const STATUS_R3 = statusR3Json as unknown as StorageStatus;
const DRY_HOLDERS = pruneDryHoldersJson as unknown as StoragePruneResult;
const DRY_CLEAN = pruneDryCleanJson as unknown as StoragePruneResult;
const DRY_R3 = pruneDryR3Json as unknown as StoragePruneResult;
const REAL_CLEAN = pruneRealCleanJson as unknown as StoragePruneResult;
const REAL_R3 = pruneRealR3Json as unknown as StoragePruneResult;
const REFUSED_R3 = pruneRefusedR3Json as unknown as StoragePruneResult;
const REFUSED_R2 = pruneRefusedR2Json as unknown as StoragePruneResult;
const OFFLOAD_BACKUP = offloadBackupJson as unknown as StorageOffloadResult;
const OFFLOAD_R3 = offloadR3Json as unknown as StorageOffloadResult;

describe("offload result (F1)", () => {
  it("reports real freed bytes after a no-backup offload", () => {
    const out = offloadOutcome(OFFLOAD_R3, "this Mac");
    expect(out).toEqual({
      ok: true,
      lines: ["Moved 6 old copies (361.0 MB) to HQ cloud. Freed 361.0 MB on this Mac."],
    });
  });

  it("never says 'Nothing needed moving' after uploads, even with 0 freed", () => {
    const out = offloadOutcome(OFFLOAD_BACKUP, "this Mac");
    expect(out.lines.join(" ")).not.toContain("Nothing needed moving");
    expect(out.lines[0]).toMatch(/^Moved 6 old copies \(361\.0 MB\) to HQ cloud\./);
    const later = { ...OFFLOAD_BACKUP, history: { ...OFFLOAD_BACKUP.history, reclaim_after: "2026-10-10T21:26:58Z" } };
    const line = offloadOutcome(later, "this Mac").lines[0];
    expect(line).toContain(`Space is freed by ${localTime("2026-10-10T21:26:58Z")}.`);
    expect(line).not.toContain("Freed 0");
  });
});

describe("prune (F2)", () => {
  it("blocks a dry run that would free nothing because refs hold the history", () => {
    expect(pruneHolders(DRY_HOLDERS)?.count).toBe(6);
    expect(pruneHolders(DRY_CLEAN)).toBeNull();
    expect(holdersCopy(6)).toBe("Nothing can be freed yet. 6 older branches or saved versions still use this history.");
    expect(holdersCopy(6)).not.toMatch(/delete|stash/i);
  });

  it("names holders in plain words without telling anyone to delete a stash", () => {
    const labels = (DRY_HOLDERS.local!.holding_refs ?? []).map(holderLabel);
    expect(labels).toEqual([
      "Changes set aside for later",
      "Saved version v-new",
      "Branch side",
      "Branch old-branch",
      "Saved version v-old-annot",
      "Saved version v-old-light",
    ]);
  });

  it("a refusal never shows a Freed line", () => {
    for (const r of [REFUSED_R3, REFUSED_R2]) {
      const out = pruneOutcome([r], "this Mac");
      expect(out.lines.join(" ")).not.toMatch(/Freed|removed/);
      expect(out.lines[0]).toMatch(/^Nothing can be freed yet\./);
      expect(out.errors).toEqual([]);
      expect(prunedBytes(r)).toBe(0);
    }
  });

  it("a success with the undo backup says when the space is freed", () => {
    const by = localTime("2026-10-10T21:26:58Z");
    expect(pruneOutcome([REAL_R3], "this Mac").lines).toEqual([
      `Old backups removed. About 120.1 MB will be freed by ${by}.`,
    ]);
    // Round-2 CLI: only backup_ref and the estimate; the same answer.
    expect(pruneOutcome([REAL_CLEAN], "this Mac").lines).toEqual([
      `Old backups removed. About 120.1 MB will be freed by ${by}.`,
    ]);
  });

  it("confirm copy says undo history is kept and when the space is freed", () => {
    const local = pruneConfirmCopy({ parts: ["backups on this Mac from before 2026-01-01 (about 120.1 MB)"], bytes: prunedBytes(DRY_R3), notes: [], local: true, cloud: false, reclaimAfter: DRY_R3.local!.reclaim_after });
    expect(local).toMatch(/^This deletes backups on this Mac/);
    expect(local).toContain(`by ${localTime(DRY_R3.local!.reclaim_after)}.`);
    expect(local).toContain("HQ keeps recent undo history until then. After that, these old versions are gone for good.");
    expect(local).not.toContain("24 hours");
    // No date from the CLI: say the 30-day bound plainly.
    const noDate = pruneConfirmCopy({ parts: ["backups on this Mac"], bytes: 1, notes: [], local: true, cloud: false });
    expect(noDate).toContain("HQ keeps recent undo history, so the space can take up to 30 days to free. After that, these old versions are gone for good.");
    expect(local).not.toContain("can't be undone");
    const cloud = pruneConfirmCopy({ parts: ["old file versions in acme from before 2026-01-01 (about 1 GB)"], bytes: 1, notes: [], local: false, cloud: true });
    expect(cloud).toContain("This can't be undone.");
  });
});

describe("fetch errors (desktop review info 1)", () => {
  it("orphaned and not-member never say try again", () => {
    expect(cloudFileErrorCopy("orphaned")).toBe("A teammate deleted this file. It's no longer in your team's cloud.");
    expect(cloudFileErrorCopy("not-member")).toBe("You're no longer a member of this company, so this file can't be downloaded.");
  });
});

// --- Pane -------------------------------------------------------------------

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll("[data-testid='confirm-dialog']").forEach((n) => n.remove());
});

async function render(storage: Record<string, unknown>): Promise<void> {
  const adapter = { storage, identity: {} } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(StorageSettingsPane, { target: host, props: { adapter } });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

/** Real status with one deletable band so Delete can run. */
function statusWithBand(base: StorageStatus): StorageStatus {
  return {
    ...base,
    local: {
      ...base.local,
      tranches: [
        { id: "7d", label: "Last 7 days", commit_count: 4, est_bytes: 54 },
        { id: "older", label: "Older than 1 year", commit_count: 100, est_bytes: 120 * 1024 * 1024 },
      ],
    },
  };
}

describe("StorageSettingsPane round 3", () => {
  it("shows a Storage heading and pending reclaim from status", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_R3 }) });
    expect(q("settings-storage-heading")?.textContent).toContain("Storage");
    expect(q("settings-storage-pending-reclaim")?.textContent).toBe(
      `120.1 MB will be freed by ${localTime("2026-10-10T21:26:58Z")}.`,
    );
  });

  it("no pending line when the CLI reports none", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_HOLDERS }) });
    expect(q("settings-storage-pending-reclaim")).toBeNull();
  });

  it("explains ~0 B bands when refs hold all old history (real status)", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_HOLDERS }) });
    const held = q("settings-storage-local-held");
    expect(held?.textContent).toContain(
      "Nothing can be freed yet. 6 older branches or saved versions still use this history.",
    );
    expect(held?.textContent).toContain("Changes set aside for later");
    expect(held?.textContent).not.toMatch(/delete/i);
  });

  it("no held note when some old history can be freed", async () => {
    await render({ status: async () => ({ ok: true, value: statusWithBand(STATUS_HOLDERS) }) });
    expect(q("settings-storage-local-held")).toBeNull();
  });

  it("blocks confirm when the dry run is held by refs and lists them", async () => {
    const prune = vi.fn();
    await render({
      status: async () => ({ ok: true, value: statusWithBand(STATUS_HOLDERS) }),
      previewPrune: async (): Promise<AdapterResult<StoragePruneResult>> => ({ ok: true, value: DRY_HOLDERS }),
      prune,
    });
    (q("storage-local-band-older") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")!.click();
    await settle();
    expect(document.querySelector("[data-testid='confirm-dialog']")?.textContent ?? "").not.toContain("Delete old backups?");
    expect(q("settings-storage-action-error")?.textContent).toBe(
      "Nothing can be freed yet. 6 older branches or saved versions still use this history.",
    );
    expect(q("settings-storage-holders")?.textContent).toContain("Branch old-branch");
    expect(prune).not.toHaveBeenCalled();
  });

  it("a refused real run shows no Freed line", async () => {
    await render({
      status: async () => ({ ok: true, value: statusWithBand(STATUS_HOLDERS) }),
      previewPrune: async () => ({ ok: true, value: DRY_CLEAN }),
      prune: async () => ({ ok: true, value: REFUSED_R3 }),
    });
    (q("storage-local-band-older") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")!.click();
    await settle();
    const dialog = document.querySelector("[data-testid='confirm-dialog']")!;
    Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.includes("Delete"))!.click();
    await settle();
    const text = q("settings-storage-result")?.textContent ?? "";
    expect(text).toContain("Nothing can be freed yet.");
    expect(text).not.toContain("Freed");
  });
});
