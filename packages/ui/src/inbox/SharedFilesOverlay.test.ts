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
});
