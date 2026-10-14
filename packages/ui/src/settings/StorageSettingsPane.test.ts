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

/** Zeroed local prune fields; tests spread the dry-run or real-run values over it. */
const LOCAL_PRUNE = {
  available: true,
  would_remove_commits: 0,
  est_bytes: 0,
  removed_commits: 0,
  total_commits_before: 0,
  flattened_merges: 0,
  retained_refs: 0,
};

export const SAMPLE_STATUS: StorageStatus = {
  local: {
    available: true,
    root: "/Users/me/HQ",
    git_dir_bytes: 76.3 * GB,
    working_tree_bytes: 4.2 * GB,
    commit_count: 5200,
    tranches: [
      { id: "7d", label: "Last 7 days", commit_count: 120, est_bytes: 0.4 * GB },
      { id: "30d", label: "7–30 days", commit_count: 400, est_bytes: 2 * GB },
      { id: "90d", label: "30–90 days", commit_count: 900, est_bytes: 9 * GB },
      { id: "365d", label: "90 days–1 year", commit_count: 2100, est_bytes: 30 * GB },
      { id: "older", label: "Older than 1 year", commit_count: 1680, est_bytes: 34.9 * GB },
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
        { id: "30d", label: "8-30 days", count: 2500, bytes: 1 * GB },
        { id: "90d", label: "31-90 days", count: 0, bytes: 0 },
        { id: "365d", label: "91-365 days", count: 0, bytes: 0 },
        { id: "older", label: "Older than a year", count: 15000, bytes: 4.8 * GB },
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

function adapter(
  storage: Partial<StorageMock> | null,
  memberships?: Record<string, unknown>[],
): PlatformAdapter {
  return {
    isAvailable: () => false,
    storage: storage ?? undefined,
    identity: memberships ? { listWorkspaces: async () => ({ ok: true, value: memberships }) } : undefined,
  } as unknown as PlatformAdapter;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

async function render(
  storage: Partial<StorageMock> | null,
  memberships?: Record<string, unknown>[],
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(StorageSettingsPane, {
    target: host,
    props: { adapter: adapter(storage, memberships) },
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
    expect(q("settings-storage-total")?.textContent).toMatch(/HQ backups on this (Mac|PC|computer): 76\.30 GB/);
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
    // Shapes from hq-cli `storage prune --json` with the hq-core script's local output.
    const previewPrune = vi.fn(async (): Promise<AdapterResult<StoragePruneResult>> => ({
      ok: true,
      value: {
        local: { ...LOCAL_PRUNE, would_remove_commits: 3990, est_bytes: 64 * GB, retained_refs: 0 },
        cloud: [],
        dry_run: true,
      },
    }));
    const prune = vi.fn(async (_req: StoragePruneRequest): Promise<AdapterResult<StoragePruneResult>> => ({
      ok: true,
      value: {
        local: {
          ...LOCAL_PRUNE,
          removed_commits: 3990,
          total_commits_before: 4200,
          before: { git_dir_bytes: 80 * GB },
          after: { git_dir_bytes: 16 * GB },
        },
        cloud: [],
        dry_run: false,
      },
    }));
    const status = vi.fn(async () => ({ ok: true as const, value: SAMPLE_STATUS }));
    await render({ status, previewPrune, prune });

    (q("storage-local-band-365d") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")?.click();
    await settle();

    expect(previewPrune).toHaveBeenCalledTimes(1);
    expect(prune).not.toHaveBeenCalled();
    const dialog = document.querySelector("[data-testid='confirm-dialog']");
    expect(dialog?.textContent).toContain("This deletes backups on this");
    expect(dialog?.textContent).toMatch(/HQ keeps recent undo history.*After that, these old versions are gone for good\./);
    expect(dialog?.textContent).not.toContain("24 hours");
    expect(dialog?.textContent).not.toContain("can't be undone");
    expect(dialog?.textContent).toContain("64.00 GB");

    const confirm = Array.from(dialog!.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Delete"),
    );
    confirm!.click();
    await settle();

    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune.mock.calls[0]![0]).toHaveProperty("localBefore");
    expect(q("settings-storage-result")?.textContent).toContain("Old backups removed. Freed 64.00 GB.");
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("cancelling the confirm deletes nothing", async () => {
    const prune = vi.fn();
    await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      previewPrune: async () => ({
        ok: true,
        value: { local: { ...LOCAL_PRUNE, would_remove_commits: 1, est_bytes: 1 }, cloud: [], dry_run: true },
      }),
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

  it("says in the confirm dialog that old tool bookmarks will be cleared", async () => {
    await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      previewPrune: async () => ({
        ok: true,
        value: {
          local: { ...LOCAL_PRUNE, would_remove_commits: 10, est_bytes: GB, refs_to_remove: 3 },
          cloud: [],
          dry_run: true,
        },
      }),
      prune: vi.fn(),
    });
    (q("storage-local-band-older") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")?.click();
    await settle();
    const dialog = document.querySelector("[data-testid='confirm-dialog']");
    expect(dialog?.textContent).toContain("3 old bookmarks other tools left behind will also be cleared.");
  });

  it("members see cloud sizes but cannot tick cloud bands", async () => {
    await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      previewPrune: vi.fn(),
      prune: vi.fn(),
    }, [{ companySlug: "indigo", role: "member", status: "active" }]);
    expect(q("settings-storage-cloud-indigo-admin-only")?.textContent).toBe(
      "Only company owners and admins can delete cloud history.",
    );
    expect((q("storage-cloud-indigo-band-older") as HTMLInputElement).disabled).toBe(true);
    expect(q("settings-storage-cloud-indigo")?.textContent).toContain("old versions");
  });

  it("reports per-company cloud errors in plain words", async () => {
    await render({
      status: async () => ({ ok: true, value: SAMPLE_STATUS }),
      previewPrune: async () => ({ ok: true, value: { local: null, cloud: [], dry_run: true } }),
      prune: async () => ({
        ok: true,
        value: {
          local: null,
          cloud: [
            {
              company: "indigo",
              deleted_count: 0,
              deleted_bytes: 0,
              errors: ["Access denied deleting old versions (needs s3:DeleteObjectVersion on the vault bucket)."],
            },
          ],
          dry_run: false,
        },
      }),
    });
    (q("storage-local-band-older") as HTMLInputElement).click();
    await settle();
    q("settings-storage-delete")?.click();
    await settle();
    const dialog = document.querySelector("[data-testid='confirm-dialog']");
    Array.from(dialog!.querySelectorAll("button")).find((b) => b.textContent?.includes("Delete"))!.click();
    await settle();
    const text = q("settings-storage-result")?.textContent ?? "";
    expect(text).toContain("indigo: Only company owners and admins can delete cloud history.");
    expect(text).not.toContain("s3:");
  });
});

/** Adapter whose identity answers the hq-storage flag per company. */
function gatedAdapter(
  storage: Partial<StorageMock> | null,
  opts: {
    rows?: Record<string, unknown>[] | "fail";
    flag?: (flag: string, companyUid: string) => Promise<boolean>;
  } = {},
): PlatformAdapter {
  const rows = opts.rows ?? [
    { slug: "indigo", cloudUid: "cmp_indigo01", membershipStatus: "active", role: "owner" },
  ];
  return {
    isAvailable: () => false,
    storage: storage ?? undefined,
    identity: {
      listWorkspaces: async () =>
        rows === "fail" ? { ok: false, code: "cloud-unreachable", message: "x" } : { ok: true, value: rows },
      hasCompanyFeature:
        opts.flag ?? (async (flag: string, uid: string) => flag === "hq-storage" && uid === "cmp_indigo01"),
    },
  } as unknown as PlatformAdapter;
}

async function mountShell(a: PlatformAdapter): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, { target: host, props: { adapter: a } });
  await settle();
}

describe("Settings › Storage hq-storage gate (Indigo-only, fails closed)", () => {
  const pending = { status: () => new Promise<never>(() => {}) };

  it("is hidden when the flag is off for every company", async () => {
    await mountShell(gatedAdapter(pending, { flag: async () => false }));
    expect(q("settings-nav-storage")).toBeNull();
  });

  it("is hidden when the flag read rejects", async () => {
    await mountShell(
      gatedAdapter(pending, {
        flag: async () => {
          throw new Error("registry down");
        },
      }),
    );
    expect(q("settings-nav-storage")).toBeNull();
  });

  it("is hidden when memberships cannot be read", async () => {
    await mountShell(gatedAdapter(pending, { rows: "fail" }));
    expect(q("settings-nav-storage")).toBeNull();
  });

  it("ignores pending invites and local-only workspaces", async () => {
    const flag = vi.fn(async () => true);
    await mountShell(
      gatedAdapter(pending, {
        rows: [
          { slug: "indigo", cloudUid: "cmp_indigo01", membershipStatus: "pending" },
          { slug: "local", cloudUid: null, membershipStatus: null },
        ],
        flag,
      }),
    );
    expect(flag).not.toHaveBeenCalled();
    expect(q("settings-nav-storage")).toBeNull();
  });

  it("is shown when the flag is on for one of the person's companies", async () => {
    const flag = vi.fn(async (_flag: string, uid: string) => uid === "cmp_indigo01");
    await mountShell(
      gatedAdapter(pending, {
        rows: [
          { slug: "acme", cloudUid: "cmp_acme0001", membershipStatus: "active" },
          { slug: "indigo", cloudUid: "cmp_indigo01", membershipStatus: "active" },
        ],
        flag,
      }),
    );
    expect(flag).toHaveBeenCalledWith("hq-storage", "cmp_indigo01");
    expect(flag).toHaveBeenCalledWith("hq-storage", "cmp_acme0001");
    expect(q("settings-nav-storage")).not.toBeNull();
  });

  it("hides the entry and the page when the CLI refuses with feature_disabled", async () => {
    await mountShell(
      gatedAdapter({
        status: async () => ({ ok: false, code: "error", message: "storage-feature-disabled" }) as never,
      }),
    );
    const nav = q("settings-nav-storage") as HTMLButtonElement | null;
    expect(nav).not.toBeNull();
    nav!.click();
    await settle();
    expect(q("settings-storage-error")).toBeNull();
    expect(q("settings-storage-pane")).toBeNull();
    expect(q("settings-nav-storage")).toBeNull();
  });

  it("the pane renders nothing on a feature_disabled refusal", async () => {
    await render({
      status: async () => ({ ok: false, code: "error", message: "storage-feature-disabled" }) as never,
    });
    expect(q("settings-storage-error")).toBeNull();
    expect(q("settings-storage-pane")?.textContent?.trim()).toBe("");
  });
});

describe("Settings › Storage in the settings list", () => {
  it("is a nav item when the host has the storage group and the flag is on", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ShellSettings, {
      target: host,
      props: { adapter: gatedAdapter({ status: () => new Promise(() => {}) }) },
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
    component = mount(ShellSettings, { target: host, props: { adapter: gatedAdapter(null) } });
    await settle();
    expect(q("settings-nav-storage")).toBeNull();
  });
});
