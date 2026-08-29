// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
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
  body: "Hi",
  createdAt: "2026-08-28T01:14:00.000Z",
};

const reply = {
  eventId: "evt_reply",
  direction: "in",
  fromPersonUid: "prs_stefan",
  fromDisplayName: "Stefan Johnson",
  body: "hello!",
  createdAt: "2026-08-28T01:15:00.000Z",
};

/** Minimal ConversationApi that returns a fixed root + one reply, no network.
 *  Only fetchReplyThread/sendReply are exercised; cast for the unused rest. */
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

function mountPanel(props: Record<string, unknown> = {}): HTMLDivElement {
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
      ...props,
    },
  });
  return host;
}

describe("ReplyPanel thread parity", () => {
  it("does not render a reaction bar for a message with no reactions", async () => {
    const h = mountPanel();
    await tick();
    await Promise.resolve();
    await tick();
    // No reactions supplied → no always-on ReactionBar add button (the spacing
    // + design gap vs main chat). The hover quick-react toolbar is used instead.
    expect(h.querySelector(".reaction-bar")).toBeNull();
    expect(h.querySelector(".reply-quick-react")).not.toBeNull();
  });

  it("makes author names clickable to open a profile when onopenprofile is set", async () => {
    let opened: { personUid: string } | null = null;
    const h = mountPanel({
      onopenprofile: (a: { personUid: string }) => (opened = a),
    });
    await tick();
    await Promise.resolve();
    await tick();
    const btn = h.querySelector(
      '[data-testid="reply-author-open"]',
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    expect(opened).not.toBeNull();
    expect(opened!.personUid).toBe("prs_stefan");
  });
});
