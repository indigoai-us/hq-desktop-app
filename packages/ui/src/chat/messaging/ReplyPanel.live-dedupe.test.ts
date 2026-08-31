// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import {
  createChatWakeBus,
  type ConversationApi,
  type ConversationMessageWire,
} from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const root: ConversationMessageWire = {
  eventId: "evt_root",
  direction: "in",
  fromPersonUid: "prs_yousuf",
  fromDisplayName: "Yousuf Kalim",
  body: "Hi",
  createdAt: "2026-08-28T01:14:00.000Z",
};

function replyRow(
  overrides: Partial<ConversationMessageWire> & { eventId: string; body: string },
): ConversationMessageWire {
  return {
    direction: "out",
    fromDisplayName: "You",
    createdAt: "2026-08-28T01:16:00.000Z",
    rootEventId: "evt_root",
    ...overrides,
  };
}

function messageRows(target: HTMLElement): HTMLElement[] {
  return [...target.querySelectorAll<HTMLElement>('[data-testid="reply-panel-message"]')];
}

function mountPanel(props: Record<string, unknown> = {}): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: {
        fetchReplyThread: async () => ({
          scope: "channel",
          root,
          replies: [],
          replyCount: 0,
        }),
        sendReply: async () => ({}),
      } as unknown as ConversationApi,
      rootEventId: "evt_root",
      scope: "channel",
      channelId: "chn_1",
      seedRoot: root,
      onclose: () => {},
      ...props,
    },
  });
  return host;
}

describe("ReplyPanel live / eventId dedupe", () => {
  it("does not render a live-arriving server copy of an optimistic reply twice", async () => {
    const body = "are about to drop?";
    let serverReplies: ConversationMessageWire[] = [];
    const sendGate: { release: (() => void) | null } = { release: null };
    const wakes = createChatWakeBus();
    const h = mountPanel({
      wakes,
      api: {
        fetchReplyThread: async () => ({
          scope: "channel",
          root,
          replies: [...serverReplies],
          replyCount: serverReplies.length,
        }),
        sendReply: () =>
          new Promise<void>((resolve) => {
            sendGate.release = resolve;
          }),
      },
    });
    await tick();
    await Promise.resolve();
    await tick();

    const composer = h.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = body;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (
      h.querySelector('[data-testid="reply-panel-send"]') as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(
        messageRows(h).filter((row) => row.textContent?.includes(body)),
      ).toHaveLength(1);
    });

    serverReplies = [
      replyRow({ eventId: "evt_live", body, direction: "out" }),
    ];
    wakes.emit("reply:new", {
      rootEventId: "evt_root",
      eventId: "evt_live",
      scope: "channel",
      channelId: "chn_1",
    });
    await vi.waitFor(() => {
      const matching = messageRows(h).filter((row) =>
        row.textContent?.includes(body),
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]?.getAttribute("data-event-id")).toBe("evt_live");
    });

    sendGate.release?.();
    await tick();
    await Promise.resolve();
    await tick();
    expect(
      messageRows(h).filter((row) => row.textContent?.includes(body)),
    ).toHaveLength(1);
  });

  it("renders replies with a duplicate eventId from the API once", async () => {
    const h = mountPanel({
      api: {
        fetchReplyThread: async () => ({
          scope: "channel",
          root,
          replies: [
            replyRow({
              eventId: "evt_dup",
              body: "once",
              createdAt: "2026-08-28T01:16:00.000Z",
            }),
            replyRow({
              eventId: " evt_dup ",
              body: "twice",
              createdAt: "2026-08-28T01:17:00.000Z",
            }),
          ],
          replyCount: 2,
        }),
        sendReply: async () => ({}),
      },
    });
    await tick();
    await Promise.resolve();
    await tick();
    await vi.waitFor(() => {
      expect(messageRows(h)).toHaveLength(1);
    });
    const row = messageRows(h)[0];
    expect(row?.getAttribute("data-event-id")?.trim()).toBe("evt_dup");
    expect(row?.textContent).toContain("once");
    expect(row?.textContent).not.toContain("twice");
  });
});
