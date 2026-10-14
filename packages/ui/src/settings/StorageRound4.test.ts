// @vitest-environment happy-dom

/**
 * Round 4: old big files a linked worktree still uses (hq-cli feat/hq-storage
 * 8c616b80). They can't be freed, so the pane says so, offload refuses with
 * the CLI's plain message, and prune holders name worktrees by folder.
 * Fixtures: __fixtures__/storage/*-r4.json (see README.md there).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import type { PlatformAdapter, StorageOffloadResult, StoragePruneResult, StorageStatus } from "@hq/platform";
import StorageSettingsPane from "./StorageSettingsPane.svelte";
import {
  historyHeld,
  historyHeldCopy,
  holderLabel,
  holdersCopy,
  offloadFreedBytes,
  offloadOutcome,
  offloadPreviewBlocker,
  offloadRefusedCopy,
  offloadSummary,
  pruneHolders,
  pruneOutcome,
  worktreeName,
} from "./storage-model.js";

import statusHeldJson from "./__fixtures__/storage/status-held-r4.json";
import statusR3Json from "./__fixtures__/storage/status-r3.json";
import offloadDryHeldJson from "./__fixtures__/storage/offload-dry-held-r4.json";
import offloadRefusedJson from "./__fixtures__/storage/offload-refused-r4.json";
import offloadDryRefusedJson from "./__fixtures__/storage/offload-dry-refused-r4.json";
import pruneRefusedWtJson from "./__fixtures__/storage/prune-refused-worktree-r4.json";

const STATUS_HELD = statusHeldJson as unknown as StorageStatus;
const STATUS_R3 = statusR3Json as unknown as StorageStatus;
const DRY_HELD = offloadDryHeldJson as unknown as StorageOffloadResult;
const REFUSED = offloadRefusedJson as unknown as StorageOffloadResult;
const DRY_REFUSED = offloadDryRefusedJson as unknown as StorageOffloadResult;
const PRUNE_WT = pruneRefusedWtJson as unknown as StoragePruneResult;

describe("worktree names", () => {
  it("keeps only the folder name", () => {
    expect(worktreeName(".claude/worktrees/old-ui")).toBe("old-ui");
    expect(worktreeName("worktree:/Users/a/HQ/wt/x/")).toBe("x");
    expect(worktreeName("C:\\HQ\\wt\\y")).toBe("y");
  });
});

describe("history held by other worktrees", () => {
  it("reads history_held and says it stays on this computer", () => {
    const held = historyHeld(STATUS_HELD.offload)!;
    expect(held).toEqual({ count: 2, bytes: 126178646, names: ["old-ui"] });
    expect(historyHeldCopy(held, "this Mac")).toBe(
      "120.3 MB is still used by another HQ worktree, so it stays on this Mac.",
    );
    expect(historyHeldCopy({ bytes: 1024, names: ["a", "b"] }, "this Mac")).toBe(
      "1.0 KB is still used by 2 other HQ worktrees, so it stays on this Mac.",
    );
  });

  it("is absent on older CLI output", () => {
    expect(historyHeld(STATUS_R3.offload)).toBeNull();
  });

  it("a dry run with held copies only counts the free ones", () => {
    expect(offloadPreviewBlocker(DRY_HELD)).toBeNull();
    expect(offloadFreedBytes(DRY_HELD)).toBe(252357290);
    expect(offloadSummary(DRY_HELD)).toBe("4 old copies of big files in your backup history");
  });
});

describe("offload refused: nothing to free", () => {
  it("the dry run blocks with the CLI's message, folder names only", () => {
    const copy = offloadPreviewBlocker(DRY_REFUSED)!;
    expect(copy).toContain("Nothing was uploaded or changed.");
    expect(copy).toContain("(worktree old-ui)");
    expect(copy).not.toContain(".claude/");
    expect(copy).not.toMatch(/Nothing to move|frees about/);
    expect(offloadFreedBytes(DRY_REFUSED)).toBe(0);
  });

  it("a real refusal shows the message, not a Freed line", () => {
    const out = offloadOutcome(REFUSED, "this Mac");
    expect(out.ok).toBe(true);
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("still used by another worktree");
    expect(out.lines[0]).not.toMatch(/Freed|Nothing needed moving|\.claude\//);
  });

  it("falls back to plain copy when the CLI sent no message", () => {
    const bare = { ...REFUSED, history: { ...REFUSED.history, message: null } };
    expect(offloadRefusedCopy(bare, "this Mac")).toBe(
      "Nothing was uploaded or changed. Other HQ worktrees still use these old files, so they stay on this Mac.",
    );
  });
});

describe("prune held by a worktree", () => {
  it("mentions worktrees and names them by folder", () => {
    const held = pruneHolders(PRUNE_WT)!;
    expect(held.count).toBe(2);
    expect(holdersCopy(held.count, held.refs)).toBe(
      "Nothing can be freed yet. 2 branches, saved versions or worktrees still use this history.",
    );
    expect(held.refs.map(holderLabel)).toEqual(["Branch side", "Worktree old-ui"]);
    expect(pruneOutcome([PRUNE_WT]).lines).toEqual([
      "Nothing can be freed yet. 2 branches, saved versions or worktrees still use this history.",
    ]);
  });

  it("keeps the old wording without worktree holders", () => {
    expect(holdersCopy(1, [{ name: "refs/heads/a", commit_date: null }])).toBe(
      "Nothing can be freed yet. 1 older branch or saved version still uses this history.",
    );
    expect(holdersCopy(1, [{ name: "worktree:wt/a", commit_date: null }])).toBe(
      "Nothing can be freed yet. 1 branch, saved version or worktree still uses this history.",
    );
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

describe("StorageSettingsPane round 4", () => {
  it("shows what other worktrees keep, with folder names", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_HELD }) });
    expect(q("settings-storage-history-held")?.textContent).toMatch(
      /^120\.3 MB is still used by another HQ worktree, so it stays on this /,
    );
    const list = q("settings-storage-history-held-list")?.textContent ?? "";
    expect(list).toContain("Worktree old-ui");
    expect(list).not.toContain(".claude/");
    // The button only promises what can be freed.
    expect(q("settings-storage-offload")?.textContent).toContain("free ~240.7 MB");
  });

  it("no held line on older CLI output", async () => {
    await render({ status: async () => ({ ok: true, value: STATUS_R3 }) });
    expect(q("settings-storage-history-held")).toBeNull();
  });

  it("a refused dry run shows the CLI's message and never opens the confirm", async () => {
    const offload = vi.fn();
    await render({
      status: async () => ({ ok: true, value: STATUS_HELD }),
      previewOffload: async () => ({ ok: true, value: DRY_REFUSED }),
      offload,
    });
    q("settings-storage-offload")!.click();
    await settle();
    const text = q("settings-storage-offload-error")?.textContent ?? "";
    expect(text).toContain("Nothing was uploaded or changed.");
    expect(text).not.toMatch(/Nothing to move|frees about/);
    expect(document.querySelector("[data-testid='confirm-dialog']")).toBeNull();
    expect(offload).not.toHaveBeenCalled();
  });

  it("the confirm states only the freeable size", async () => {
    await render({
      status: async () => ({ ok: true, value: STATUS_HELD }),
      previewOffload: async () => ({ ok: true, value: DRY_HELD }),
      offload: vi.fn(),
    });
    q("settings-storage-offload")!.click();
    await settle();
    const dialog = document.querySelector("[data-testid='confirm-dialog']")?.textContent ?? "";
    expect(dialog).toContain("This frees about 240.7 MB");
    expect(dialog).not.toContain("361.0 MB");
  });
});
