// @vitest-environment happy-dom
/**
 * A message's profile picture opens the author's profile, as the name does
 * (owner review 2026-10-09), in the conversation and in a reply thread.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
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
  eventId: "evt_1",
  direction: "in",
  fromPersonUid: "prs_maya",
  fromDisplayName: "Maya Chen",
  body: "Hi",
  createdAt: "2026-10-08T01:14:00.000Z",
};
const reply = { ...root, eventId: "evt_2", fromPersonUid: "prs_corey", fromDisplayName: "Corey Epstein", body: "Hey", createdAt: "2026-10-08T01:20:00.000Z" };

function mountIn(comp: typeof ChannelConversation | typeof ReplyPanel, props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  // Props vary by component; each test passes what that one needs.
  component = mount(comp as unknown as Parameters<typeof mount>[0], { target: host, props });
}

describe("a message's picture opens the author's profile", () => {
  it("in the conversation", async () => {
    const opened: string[] = [];
    mountIn(ChannelConversation, { messages: [root], onopenprofile: (a: { personUid: string }) => opened.push(a.personUid) });
    await tick();
    const pic = host.querySelector<HTMLButtonElement>('[data-testid="conversation-avatar-open"]');
    expect(pic?.getAttribute("aria-label")).toBe("Open Maya Chen's profile");
    pic!.click();
    expect(opened).toEqual(["prs_maya"]);
  });

  it("stays a plain picture when profiles cannot open", async () => {
    mountIn(ChannelConversation, { messages: [root] });
    await tick();
    expect(host.querySelector('[data-testid="conversation-avatar-open"]')).toBeNull();
    expect(host.querySelector(".dm-msg-avatar")).not.toBeNull();
  });

  it("in a reply thread, on the first message and on replies", async () => {
    const opened: string[] = [];
    mountIn(ReplyPanel, {
      api: {
        fetchReplyThread: async () => ({ scope: "channel", root, replies: [reply], replyCount: 1 }),
        sendReply: async () => {},
      } as unknown as ConversationApi,
      rootEventId: "evt_1",
      scope: "channel",
      channelId: "chn_1",
      seedRoot: root,
      onopenprofile: (a: { personUid: string }) => opened.push(a.personUid),
    });
    for (let i = 0; i < 5 && host.querySelectorAll('[data-testid="reply-avatar-open"]').length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await tick();
    }
    const pics = host.querySelectorAll<HTMLButtonElement>('[data-testid="reply-avatar-open"]');
    expect(pics).toHaveLength(2);
    pics.forEach((p) => p.click());
    expect(opened).toEqual(["prs_maya", "prs_corey"]);
  });
});
