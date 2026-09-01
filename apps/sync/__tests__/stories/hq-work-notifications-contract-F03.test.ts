/**
 * F-03 semantic contract: the exact Rust `fetch_notifications` envelope must
 * arrive at the live composer unchanged enough to preserve badge and paging
 * state. This intentionally crosses Sync adapter -> UI composer.
 */
import { describe, expect, it } from "vitest";
import { createLiveNotificationsApi } from "@hq/ui";

import {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
} from "../../src/lib/hq-work-adapter";

function invoker(): SyncInvokeFn {
  return async (command, args) => {
    if (command === "fetch_notifications") {
      expect(args).toEqual({
        limit: 25,
        cursor: "opaque-next-page",
        unreadOnly: true,
      });
      return {
        notifications: [
          {
            id: "notif-mention-1",
            type: "mention",
            status: "unread",
            title: "mentioned you",
            actionRef: "work-item-17",
            actionKind: "review",
            companyUid: "cmp_indigo",
          },
        ],
        unreadCount: 7,
        nextCursor: "opaque-next-page",
      };
    }
    if (command === "hq_pro_fetch") {
      const url = String(args?.url ?? "");
      if (url.startsWith("/v1/notify/inbox")) {
        return { status: 200, body: JSON.stringify({ events: [] }) };
      }
      if (url.startsWith("/v1/files/shared-with-me")) {
        return { status: 200, body: JSON.stringify({ events: [] }) };
      }
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

describe("F-03 Sync notification semantic contract", () => {
  it("preserves the Rust feed envelope through the Sync adapter and live composer", async () => {
    const adapter = createSyncPlatformAdapter({ invoke: invoker() });
    const api = createLiveNotificationsApi(adapter);

    await expect(
      api.fetchNotifications({
        limit: 25,
        cursor: "opaque-next-page",
        unreadOnly: true,
      }),
    ).resolves.toEqual({
      notifications: [
        expect.objectContaining({
          id: "notif-mention-1",
          actionRef: "work-item-17",
          companyUid: "cmp_indigo",
        }),
      ],
      unreadCount: 7,
      nextCursor: "opaque-next-page",
    });
  });
});
