// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import { MARKETPLACE_COVER_HOST } from "../../avatars/csp-image-src";
import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";
import { agentAvatarAssets } from "./agent-avatars";

const ADA_PHOTO = `https://${MARKETPLACE_COVER_HOST}/members/prs_ada/h.png?X-Amz-Signature=mock`;

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
  fromPersonUid: "prs_ada",
  fromDisplayName: "Ada Lovelace",
  body: "Hi",
  createdAt: "2026-08-28T01:14:00.000Z",
};

const reply = {
  eventId: "evt_reply",
  direction: "in",
  fromPersonUid: "agt_izzy",
  fromDisplayName: "Izzy",
  body: "hello!",
  createdAt: "2026-08-28T01:15:00.000Z",
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

describe("ReplyPanel avatars", () => {
  it("renders a roster photo for a human and a generated mark for an agent", async () => {
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
        avatarByUid: { prs_ada: ADA_PHOTO },
      },
    });
    await tick();
    await Promise.resolve();

    const rootImg = host.querySelector(
      '[data-testid="reply-panel-root"] img.avatar-img',
    );
    expect(rootImg?.getAttribute("src")).toBe(ADA_PHOTO);

    await tick();
    const replyImgs = [
      ...host.querySelectorAll(
        '[data-testid="reply-panel-message"] img.avatar-img',
      ),
    ];
    expect(replyImgs.length).toBeGreaterThanOrEqual(1);
    expect(agentAvatarAssets).toContain(replyImgs[0]?.getAttribute("src"));
  });
});
