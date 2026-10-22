// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import SharedFilesOverlay from "./SharedFilesOverlay.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  flushSync();
}

describe("SharedFilesOverlay", () => {
  // Folder share for a company not synced on this Mac (feedback 3e124bcd /
  // ae977608 follow-up): list the folder from the vault and say what to sync.
  it("lists a shared folder remotely with a sync note when given a folder focus", async () => {
    const fetchSharedWithMe = vi.fn(async () => ({ ok: true as const, value: { events: [] } }));
    const listVaultPrefix = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          objects: [{ key: "knowledge/clients/frank/brief.md" }, { key: "knowledge/clients/frank/notes/a.md" }],
          cursor: "c2",
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { objects: [{ key: "knowledge/clients/frank/.DS_Store" }, { key: "knowledge/clients/other/x.md" }], cursor: null },
      });
    const presignVaultGet = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: {
        adapter: { notifications: { fetchSharedWithMe }, files: { listVaultPrefix, presignVaultGet } as never },
        folder: { companyUid: "cmp_remote", companyLabel: "Remote Co", prefix: "knowledge/clients/frank/" },
      },
    });

    await flush();
    await flush();
    expect(listVaultPrefix).toHaveBeenNthCalledWith(1, "cmp_remote", "knowledge/clients/frank/", undefined);
    expect(listVaultPrefix).toHaveBeenNthCalledWith(2, "cmp_remote", "knowledge/clients/frank/", "c2");
    expect(fetchSharedWithMe).not.toHaveBeenCalled();
    expect(presignVaultGet).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="shared-folder-title"]')?.textContent).toBe("frank");
    expect(host.querySelector('[data-testid="shared-folder-scope"]')?.textContent).toBe(
      "Shared from Remote Co · knowledge/clients/frank/",
    );
    expect(host.querySelector('[data-testid="shared-folder-sync-note"]')?.textContent?.trim()).toBe(
      "Remote Co isn't synced on this Mac yet. Sync it to open this folder in Files.",
    );
    const rows = [...host.querySelectorAll('[data-testid="shared-folder-entry"]')].map((row) => row.textContent?.trim());
    expect(rows).toEqual(["notes/", "brief.md"]);
    expect(host.querySelector('[data-testid="shared-files-event"]')).toBeNull();
  });

  it("shows the sync note and a retry when the folder listing fails", async () => {
    const fetchSharedWithMe = vi.fn(async () => ({ ok: true as const, value: { events: [] } }));
    const listVaultPrefix = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "offline" })
      .mockResolvedValueOnce({ ok: true as const, value: { objects: [], cursor: null } });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: {
        adapter: { notifications: { fetchSharedWithMe }, files: { listVaultPrefix } as never },
        folder: { companyUid: "cmp_remote", companyLabel: "Remote Co", prefix: "" },
      },
    });

    await flush();
    expect(host.querySelector('[data-testid="shared-folder-error"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="shared-folder-sync-note"]')?.textContent).toContain("Remote Co");
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="shared-folder-retry"]')?.click(),
    );
    await flush();
    expect(host.querySelector('[data-testid="shared-folder-empty"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="shared-folder-title"]')?.textContent).toBe("Remote Co");
  });

  it("loads the share-scoped event list instead of silently returning to chat", async () => {
    const fetchSharedWithMe = vi.fn(async () => ({
      ok: true as const,
      value: {
        events: [
          {
            eventId: "shr_1",
            issuerDisplayName: "Ada",
            paths: ["projects/alpha/brief.md"],
            createdAt: "2026-09-01T12:00:00.000Z",
          },
        ],
      },
    }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: { adapter: { notifications: { fetchSharedWithMe } } },
    });

    await flush();
    expect(fetchSharedWithMe).toHaveBeenCalledWith({ limit: 50 });
    expect(host.querySelector('[data-testid="shared-files-event"]')?.textContent).toContain(
      "brief.md",
    );
    expect(host.querySelector('[data-testid="shared-files-scope"]')?.textContent).toContain(
      "share-scoped",
    );
  });

  it("renders an actionable offline state", async () => {
    const fetchSharedWithMe = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "offline", message: "offline" })
      .mockResolvedValueOnce({ ok: true as const, value: { events: [] } });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: { adapter: { notifications: { fetchSharedWithMe } } },
    });

    await flush();
    expect(host.querySelector('[data-testid="shared-files-error"]')).not.toBeNull();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="shared-files-retry"]')?.click(),
    );
    await flush();
    expect(host.querySelector('[data-testid="shared-files-empty"]')).not.toBeNull();
  });

  it("continues through cursor pages without duplicating a repeated share event", async () => {
    const fetchSharedWithMe = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          events: [
            { eventId: "shr_1", issuerDisplayName: "Ada", paths: ["projects/a/one.md"] },
          ],
          nextCursor: "page-2",
        },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: {
          events: [
            { eventId: "shr_1", issuerDisplayName: "Ada", paths: ["projects/a/one.md"] },
            { eventId: "shr_2", issuerDisplayName: "Grace", paths: ["projects/a/two.md"] },
          ],
          nextCursor: null,
        },
      });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: { adapter: { notifications: { fetchSharedWithMe } } },
    });

    await flush();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="shared-files-load-more"]')?.click(),
    );
    await flush();

    expect(fetchSharedWithMe).toHaveBeenNthCalledWith(1, { limit: 50 });
    expect(fetchSharedWithMe).toHaveBeenNthCalledWith(2, { limit: 50, cursor: "page-2" });
    expect(host.querySelectorAll('[data-testid="shared-files-event"]')).toHaveLength(2);
    expect(host.textContent).toContain("one.md");
    expect(host.textContent).toContain("two.md");
    expect(host.querySelector('[data-testid="shared-files-load-more"]')).toBeNull();
  });
});
