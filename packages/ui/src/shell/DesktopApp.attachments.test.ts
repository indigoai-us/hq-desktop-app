// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const row: ConversationRow = {
  id: "ch:chn_received",
  kind: "channel",
  title: "received-images",
  companyUid: "cmp_conversation",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_received",
  channelScope: "project",
};

function adapter(
  presignVaultGet: (companyUid: string, vaultPath: string) => Promise<unknown>,
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    files: {
      presignVaultGet,
    },
    meetings: {
      listUpcoming: async () => ok([]),
      listMemberships: async () => ok([]),
      listAccounts: async () => ok([]),
      listScheduledBots: async () => ok([]),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("DesktopApp received attachment flow", () => {
  it("downloads bytes with the conversation company fallback, opens the viewer, and revokes blobs on teardown", async () => {
    const createObjectUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:received-photo");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const getAttachmentObject = vi.fn(async () => new Response("bytes"));
    const presignVaultGet = vi.fn(async () =>
      ok({
        results: [{ url: "https://vault.example/received-photo.png" }],
      }),
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(presignVaultGet),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        initialRow: row,
        searchRows: [row],
        self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
        coreFixtures: false,
        getAttachmentObject,
        messagesByRow: () => [
          {
            eventId: "evt_received_photo",
            direction: "in",
            fromDisplayName: "Corey",
            body: "Screenshot attached",
            createdAt: "2026-08-31T00:00:00.000Z",
            attachments: [
              {
                id: "att_received_photo",
                vaultPath: "chat/attachments/chn_received/photo.png",
                name: "photo.png",
                contentType: "image/png",
                sizeBytes: 5,
                kind: "image",
                // Persisted received records omit this; the conversation owns it.
                companyUid: "",
              },
              {
                id: "att_sent_photo",
                vaultPath: "chat/attachments/chn_received/sent-photo.png",
                name: "sent-photo.png",
                contentType: "image/png",
                sizeBytes: 5,
                kind: "image",
                companyUid: "cmp_sender",
              },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(
        host.querySelectorAll("[data-testid='attachment-thumb'] img"),
      ).toHaveLength(2);
    });
    expect(presignVaultGet).toHaveBeenCalledWith(
      "cmp_conversation",
      "chat/attachments/chn_received/photo.png",
    );
    expect(presignVaultGet).toHaveBeenCalledWith(
      "cmp_sender",
      "chat/attachments/chn_received/sent-photo.png",
    );
    expect(getAttachmentObject).toHaveBeenCalledWith(
      "https://vault.example/received-photo.png",
    );
    expect(createObjectUrl).toHaveBeenCalled();

    host
      .querySelector<HTMLButtonElement>("[data-testid='attachment-thumb']")
      ?.click();
    await tick();
    expect(host.querySelector("[data-testid='attachment-tray']")).toBeTruthy();

    await unmount(component);
    component = null;
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:received-photo");
  });

  it("routes cloud file previews through the same-origin byte proxy instead of the non-CORS Vault URL", async () => {
    const fetchSpy = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      new Response("# Project brief", {
        headers: { "content-type": "text/markdown" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const presignVaultGet = vi.fn(async () =>
      ok({ results: [{ url: "https://bucket.s3.amazonaws.com/projects/brief.md" }] }),
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(presignVaultGet),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        initialRow: row,
        searchRows: [row],
        coreFixtures: false,
        filesByRow: () => [
          {
            key: "projects/brief.md",
            vaultPath: "projects/brief.md",
            companyUid: "cmp_conversation",
            name: "brief.md",
            caption: "PROJECT",
            iconKind: "markdown",
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Files",
        ),
      ).toBeTruthy();
    });
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === "Files")
      ?.click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click();

    await vi.waitFor(() => {
      expect(host.textContent).toContain("# Project brief");
    });
    expect(fetchSpy).toHaveBeenCalled();
    for (const [path, init] of fetchSpy.mock.calls) {
      expect(path).toBe("/api/chat-attachment-bytes");
      expect(init).toMatchObject({
        headers: {
          "x-hq-source-url": "https://bucket.s3.amazonaws.com/projects/brief.md",
          "x-hq-max-bytes": "2097152",
        },
      });
    }
    expect(presignVaultGet).toHaveBeenCalledWith("cmp_conversation", "projects/brief.md");
  });
});
