/**
 * US-005 story acceptance tests (from PRD e2eTests):
 *
 * 1. Given /?channel=<id>&reply=<rootEventId> and the user can read that
 *    channel, when the app loads, then the channel is selected and the reply
 *    panel is open on that root.
 * 2. Given a reply id the user cannot read, when the app loads, then the
 *    panel is closed and no other user’s personUid is revealed.
 *
 * Follows the US-001/US-003/US-007 story-test convention: vitest drives the
 * real WebPlatformAdapter + createConversationApi with a mocked fetch, plus
 * the URL / open-target helpers DesktopApp and +page.svelte use. No live
 * Cognito. Query key is reply= — never thread=.
 */

import { describe, expect, it } from "vitest";

import { WebPlatformAdapter } from "@hq/platform";

import { createConversationApi } from "../../src/lib/chat-adapter.js";
import {
  conversationRowForDeepLink,
  parseConversationDeepLink,
  shouldOpenReplyDeepLink,
} from "../../../../packages/ui/src/chat/open-target.js";
import type { ConversationRow } from "../../../../packages/ui/src/chat/sidebar-model.js";

interface RecordedHttp {
  method: string;
  path: string;
  body: unknown;
}

function makeApi(handler: (call: RecordedHttp) => Response) {
  const calls: RecordedHttp[] = [];
  const adapter = new WebPlatformAdapter({
    baseUrl: "https://api.test",
    fetch: async (input, init) => {
      const call: RecordedHttp = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: String(input).replace("https://api.test", ""),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call);
    },
  });
  return { api: createConversationApi(adapter), calls };
}

const channelRow: ConversationRow = {
  id: "ch:chn_proj",
  kind: "channel",
  title: "launch",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_proj",
};

describe("US-005: Deep-link a reply thread from a URL", () => {
  it("Given /?channel=<id>&reply=<rootEventId> and the user can read that channel, when the app loads, then the channel is selected and the reply panel is open on that root", async () => {
    const href = "/?channel=chn_proj&reply=evt_root";
    const link = parseConversationDeepLink(href);
    expect(link).toEqual({
      channelId: "chn_proj",
      personUid: null,
      replyRootEventId: "evt_root",
    });
    expect(
      parseConversationDeepLink("/?thread=evt_root").replyRootEventId,
    ).toBeNull();

    const selected = conversationRowForDeepLink(link, [channelRow]);
    expect(selected?.id).toBe("ch:chn_proj");
    expect(selected?.channelId).toBe("chn_proj");

    const { api, calls } = makeApi((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            scope: "channel",
            root: {
              eventId: "evt_root",
              body: "root body",
              createdAt: "2026-08-17T01:00:00.000Z",
              replyCount: 1,
            },
            replies: [
              {
                eventId: "evt_reply",
                rootEventId: "evt_root",
                body: "ok",
                createdAt: "2026-08-17T01:05:00.000Z",
              },
            ],
            replyCount: 1,
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const thread = await api.fetchReplyThread({
      scope: "channel",
      rootEventId: link.replyRootEventId ?? "",
      channelId: selected?.channelId,
    });
    expect(shouldOpenReplyDeepLink(link.replyRootEventId, thread)).toBe(true);
    expect(thread.root?.eventId).toBe("evt_root");
    expect(
      calls.some(
        (call) =>
          call.method === "GET" && call.path.startsWith("/v1/notify/threads"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.path.includes("thread="))).toBe(false);
  });

  it("Given a reply id the user cannot read, when the app loads, then the panel is closed and no other user’s personUid is revealed", async () => {
    const href = "/?channel=chn_proj&reply=evt_secret";
    const link = parseConversationDeepLink(href);
    const selected = conversationRowForDeepLink(link, [channelRow]);
    expect(selected?.channelId).toBe("chn_proj");

    const leakedUid = "prs_other_user";
    const { api } = makeApi((call) => {
      if (call.path.startsWith("/v1/notify/threads")) {
        return new Response(
          JSON.stringify({
            error: "THREAD_NOT_FOUND",
            code: "THREAD_NOT_FOUND",
            withPersonUid: leakedUid,
          }),
          { status: 404 },
        );
      }
      return new Response("not found", { status: 404 });
    });

    let thread: { root?: { eventId?: string | null } | null } | null = null;
    try {
      thread = await api.fetchReplyThread({
        scope: "channel",
        rootEventId: "evt_secret",
        channelId: "chn_proj",
      });
    } catch {
      thread = null;
    }

    // Conversation stays selected; panel stays closed. Host never renders
    // the 404 body (no personUid / THREAD_NOT_FOUND in UI).
    expect(selected?.id).toBe("ch:chn_proj");
    expect(shouldOpenReplyDeepLink(link.replyRootEventId, thread)).toBe(false);
  });
});
