// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const root = {
  eventId: "evt_root",
  direction: "in",
  fromPersonUid: "prs_yousuf",
  fromDisplayName: "Yousuf Kalim",
  body: "kicking off",
  createdAt: "2026-08-28T01:14:00.000Z",
};

/** A stored mention row as older senders wrote it: uid + name, no type. */
const reply = {
  eventId: "evt_reply",
  direction: "in",
  fromPersonUid: "prs_stefan",
  fromDisplayName: "Stefan Johnson",
  body: "ping @Deacon and @Hassaan",
  createdAt: "2026-08-28T01:15:00.000Z",
  mentions: [
    { participantUid: "agt_deacon", displayName: "Deacon" },
    { participantUid: "prs_hassaan", displayName: "Hassaan" },
  ],
};

function api(): ConversationApi {
  return {
    fetchReplyThread: async () => ({
      scope: "channel",
      root,
      replies: [reply],
      replyCount: 1,
    }),
    sendReply: async () => ({}),
  } as unknown as ConversationApi;
}

describe("ReplyPanel stored mentions", () => {
  it("does not give an agent a clickable profile when the type is missing", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: api(),
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: root,
        onclose: () => {},
      },
    });
    await tick();
    await Promise.resolve();
    await tick();

    const mentions = [...host.querySelectorAll(".inline-mention")];
    expect(mentions.map((el) => el.textContent)).toEqual([
      "@Deacon",
      "@Hassaan",
    ]);
    // agt_* has no profile panel, so it must not be rendered as a button.
    expect(mentions[0].getAttribute("data-person-uid")).toBeNull();
    expect(mentions[1].getAttribute("data-person-uid")).toBe("prs_hassaan");
  });

  it("uses the conversation company fallback for a received image and opens the viewer", async () => {
    const receivedImageRoot = {
      ...root,
      attachments: [
        {
          id: "att_reply_photo",
          vaultPath: "chat/attachments/chn_1/att_reply_photo.png",
          name: "reply-photo.png",
          contentType: "image/png",
          sizeBytes: 128,
          kind: "image",
          // Persisted received attachments can omit their per-item company.
          companyUid: "",
        },
      ],
    };
    const onpresign = vi.fn(async () => "blob:reply-photo");
    const onopenattachment = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ReplyPanel, {
      target: host,
      props: {
        api: {
          ...api(),
          fetchReplyThread: async () => ({
            scope: "channel",
            root: receivedImageRoot,
            replies: [],
            replyCount: 0,
          }),
        },
        rootEventId: "evt_root",
        scope: "channel",
        channelId: "chn_1",
        seedRoot: receivedImageRoot,
        vaultCompanyUid: "cmp_conversation",
        onpresign,
        onopenattachment,
        onclose: () => {},
      },
    });
    await tick();
    await Promise.resolve();
    await tick();

    expect(onpresign).toHaveBeenCalledWith(
      "cmp_conversation",
      "chat/attachments/chn_1/att_reply_photo.png",
    );
    const thumb = host.querySelector<HTMLButtonElement>(
      "[data-testid='attachment-thumb']",
    );
    expect(thumb).toBeTruthy();
    thumb?.click();
    expect(onopenattachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "att_reply_photo" }),
    );
  });
});
