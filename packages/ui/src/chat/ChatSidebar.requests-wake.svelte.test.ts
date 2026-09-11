// @vitest-environment happy-dom

/**
 * The web path has no `dm:request-new` wake; a `notifications:*` reconcile
 * bumps `requestsWakeSeq` and the rail must re-read pending requests without
 * a remount. A failing read is logged, never hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { DmRequest } from "./dm-requests";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const ADA: DmRequest = {
  pairKey: "pk_ada",
  fromPersonUid: "prs_ada",
  fromEmail: "ada@example.com",
  fromDisplayName: "Ada",
  createdAt: "2026-09-10T00:00:00.000Z",
};

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_1",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage?.clear?.();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

describe("ChatSidebar requestsWakeSeq", () => {
  it("re-reads pending requests when the wake seq bumps", async () => {
    let pending: DmRequest[] = [];
    const listDmRequests = vi.fn(async () => ({ requests: pending }));
    const listContacts = vi.fn(async () => ({ contacts: [] }));
    const props = $state({
      api: stubApi({ listDmRequests, listContacts }),
      requestsWakeSeq: 0,
      bootTimeoutMs: 2_000,
    });
    component = mount(ChatSidebar, { target: host, props });
    await vi.waitFor(() => expect(listDmRequests).toHaveBeenCalledTimes(1));
    expect(host.querySelector('[data-testid="chat-connection-requests"]')).toBeNull();

    pending = [ADA];
    props.requestsWakeSeq = 1;
    await vi.waitFor(() => expect(listDmRequests).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-testid="chat-requests-count"]')?.textContent?.trim(),
      ).toBe("1"),
    );
    // A requests-only wake must not re-read contacts.
    expect(listContacts).toHaveBeenCalledTimes(1);
  });

  it("logs a failed list_dm_requests read through the sidebar log", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const listDmRequests = vi.fn(async () => {
      throw new Error("requests route down");
    });
    component = mount(ChatSidebar, {
      target: host,
      props: { api: stubApi({ listDmRequests }), bootTimeoutMs: 2_000 },
    });
    await vi.waitFor(() => {
      expect(
        info.mock.calls.some(
          ([tag, payload]) =>
            tag === "[hq-sidebar]" &&
            (payload as { event?: string; source?: string }).event === "boot-error" &&
            (payload as { source?: string }).source === "list_dm_requests",
        ),
      ).toBe(true);
    });
    info.mockRestore();
    error.mockRestore();
  });
});
