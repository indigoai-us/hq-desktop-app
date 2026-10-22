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
    const scope = host.querySelector('[data-testid="shared-folder-scope"]');
    expect(scope?.querySelector('[data-testid="company-label"] .company-label-name')?.textContent).toBe("Remote Co");
    expect(scope?.querySelector(".shared-folder-path")?.textContent).toBe("knowledge/clients/frank/");
    expect(scope?.textContent).toContain("Shared from");
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

  function mountFolder(listVaultPrefix: ReturnType<typeof vi.fn>, prefix = "knowledge/clients/frank/") {
    const fetchSharedWithMe = vi.fn(async () => ({ ok: true as const, value: { events: [] } }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SharedFilesOverlay, {
      target: host,
      props: {
        adapter: { notifications: { fetchSharedWithMe }, files: { listVaultPrefix } as never },
        folder: { companyUid: "cmp_remote", companyLabel: "Remote Co", prefix },
      },
    });
  }

  // Review of PR 1772: hq-pro returns 403 when the caller is denied and 429
  // over the hourly files limit. Neither is a connection problem, and
  // retrying at once cannot help, so there is no Retry and the server code
  // never reaches the screen.
  it.each([
    { label: "403 code", failure: { ok: false as const, reason: "error", code: "http-403", message: "Forbidden" } },
    { label: "membership text", failure: { ok: false as const, reason: "error", message: "No active membership for this company" } },
  ])("says the person has no access on a denied listing ($label), with no Retry", async ({ failure }) => {
    const listVaultPrefix = vi.fn().mockResolvedValue(failure);
    mountFolder(listVaultPrefix);

    await flush();
    const error = host.querySelector('[data-testid="shared-folder-error"]');
    expect(error?.textContent?.trim()).toBe("You don't have access to this.");
    expect(host.querySelector('[data-testid="shared-folder-retry"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="shared-folder-entry"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("403");
    expect(host.textContent).not.toContain("http-");
    expect(host.textContent).not.toContain("Forbidden");
    expect(host.textContent).not.toContain("membership");
    expect(listVaultPrefix).toHaveBeenCalledTimes(1);
  });

  it("says to wait on a rate-limited listing (429), with no Retry", async () => {
    const listVaultPrefix = vi
      .fn()
      .mockResolvedValue({ ok: false as const, reason: "error", code: "http-429", message: "Too Many Requests" });
    mountFolder(listVaultPrefix);

    await flush();
    const error = host.querySelector('[data-testid="shared-folder-error"]');
    expect(error?.textContent?.trim()).toBe(
      "You've opened a lot of folders in a short time. Wait a few minutes and open it again.",
    );
    expect(host.querySelector('[data-testid="shared-folder-retry"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="shared-folder-entry"]')).toHaveLength(0);
    expect(host.textContent).not.toContain("429");
    expect(host.textContent).not.toContain("Too Many");
    expect(listVaultPrefix).toHaveBeenCalledTimes(1);
  });

  it("keeps the connection message and Retry for any other failure", async () => {
    const listVaultPrefix = vi
      .fn()
      .mockResolvedValue({ ok: false as const, reason: "error", code: "http-500", message: "Internal Server Error" });
    mountFolder(listVaultPrefix);

    await flush();
    expect(host.querySelector('[data-testid="shared-folder-error"]')?.textContent).toContain("Check your connection");
    expect(host.querySelector('[data-testid="shared-folder-retry"]')).not.toBeNull();
    expect(host.textContent).not.toContain("500");
  });

  // Informational from the same review: the page cap and truncation note.
  it("stops a folder listing after 10 pages and says the folder is only partly shown", async () => {
    const listVaultPrefix = vi.fn(async (_company: string, _prefix: string, cursor?: string) => ({
      ok: true as const,
      value: {
        objects: [{ key: "knowledge/clients/frank/file-" + (cursor ?? "0") + ".md" }],
        cursor: "next-" + (cursor ?? "0"),
      },
    }));
    mountFolder(listVaultPrefix);

    for (let i = 0; i < 12; i += 1) await flush();
    expect(listVaultPrefix).toHaveBeenCalledTimes(10);
    expect(host.querySelectorAll('[data-testid="shared-folder-entry"]')).toHaveLength(10);
    expect(host.querySelector('[data-testid="shared-folder-truncated"]')?.textContent).toContain(
      "Showing the first part of a large folder.",
    );
    expect(host.querySelector('[data-testid="shared-folder-truncated"]')?.textContent).toContain("Remote Co");
  });

  it("stops a whole-company share after 3 pages", async () => {
    const listVaultPrefix = vi.fn(async (_company: string, _prefix: string, cursor?: string) => ({
      ok: true as const,
      value: { objects: [{ key: "top-" + (cursor ?? "0") + "/a.md" }], cursor: "next-" + (cursor ?? "0") },
    }));
    mountFolder(listVaultPrefix, "");

    for (let i = 0; i < 6; i += 1) await flush();
    expect(listVaultPrefix).toHaveBeenCalledTimes(3);
    expect(listVaultPrefix).toHaveBeenNthCalledWith(1, "cmp_remote", "", undefined);
    expect(host.querySelectorAll('[data-testid="shared-folder-entry"]')).toHaveLength(3);
    expect(host.querySelector('[data-testid="shared-folder-truncated"]')).not.toBeNull();
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
