// @vitest-environment happy-dom
/**
 * An empty thread says so once (owner, 2026-10-22). It used to show a
 * "0 REPLIES" divider over a separate "No replies yet" line.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

const root = {
  eventId: "evt_root",
  direction: "in" as const,
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada",
  body: "Root message.",
  createdAt: "2026-10-22T10:00:00.000Z",
};

function open(replies: unknown[]): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: {
        fetchReplyThread: async () => ({
          scope: "channel",
          root,
          replies,
          replyCount: replies.length,
        }),
        sendReply: async () => {},
      } as unknown as ConversationApi,
      rootEventId: root.eventId,
      scope: "channel",
      channelId: "chn_1",
      seedRoot: root,
      onclose: () => {},
    },
  });
}

describe("ReplyPanel empty thread", () => {
  it("shows one line, not a zero count over a second empty message", async () => {
    open([]);
    await tick();
    await vi.waitFor(() => {
      expect(host!.querySelectorAll('[data-testid="reply-panel-empty"]')).toHaveLength(1);
    });
    expect(host!.querySelector(".reply-root-label")).toBeNull();
    expect(host!.textContent).not.toMatch(/0\s+replies/i);
    expect(host!.textContent).toContain("No replies yet");
  });

  it("shows the count once there are replies", async () => {
    open([
      { ...root, eventId: "r1", body: "A reply.", createdAt: "2026-10-22T10:01:00.000Z" },
    ]);
    await tick();
    await vi.waitFor(() => {
      expect(host!.querySelector(".reply-root-label")?.textContent).toMatch(/1\s+reply/);
    });
    expect(host!.querySelector('[data-testid="reply-panel-empty"]')).toBeNull();
  });
});
