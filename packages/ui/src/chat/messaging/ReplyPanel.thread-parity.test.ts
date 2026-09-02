// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi, SendReplyArgs } from "../chat-api";
import type { MentionTarget } from "../mentions.js";

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
  it("registers only after the initial reply fetch supplies the seen ids", async () => {
    type ReplyThread = Awaited<ReturnType<ConversationApi["fetchReplyThread"]>>;
    let resolveFetch!: (value: ReplyThread) => void;
    const initialFetch = new Promise<ReplyThread>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchReplyThread = vi.fn(() => initialFetch);
    const onactivethreadchange = vi.fn();
    mountPanel({
      api: { fetchReplyThread, sendReply: async () => {} } as unknown as ConversationApi,
      onactivethreadchange,
    });

    await tick();
    expect(onactivethreadchange).not.toHaveBeenCalled();

    resolveFetch({ scope: "channel", root, replies: [reply], replyCount: 1 });
    await vi.waitFor(() => {
      expect(onactivethreadchange).toHaveBeenCalledWith(
        expect.objectContaining({ rootEventId: "evt_root", seenReplyIds: ["evt_reply"] }),
      );
    });
  });

  it("renders thread replies with the shared msg-body class and collapsed first-paragraph margin", async () => {
    const h = mountPanel();
    await tick();
    await Promise.resolve();
    await tick();

    const replyRow = h.querySelector(
      '[data-testid="reply-panel-message"]',
    ) as HTMLElement | null;
    expect(replyRow).not.toBeNull();
    const body = replyRow!.querySelector(".reply-md") as HTMLElement | null;
    expect(body).not.toBeNull();
    expect(body!.classList.contains("msg-body")).toBe(true);

    const paragraph = body!.querySelector("p") as HTMLElement | null;
    expect(paragraph).not.toBeNull();
    expect(getComputedStyle(paragraph!).marginTop).toBe("0px");

    const rootBody = h.querySelector(
      '[data-testid="reply-panel-root"] .reply-md',
    ) as HTMLElement | null;
    expect(rootBody?.classList.contains("msg-body")).toBe(true);
  });

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

  it("shows the mention picker and sends mentions with the reply", async () => {
    const sent: SendReplyArgs[] = [];
    const mentionCandidates: MentionTarget[] = [
      {
        participantUid: "prs_stefan",
        participantType: "human",
        displayName: "Stefan Johnson",
        email: "stefan@getindigo.ai",
      },
    ];
    const h = mountPanel({
      mentionCandidates,
      api: {
        fetchReplyThread: async () => ({
          scope: "channel",
          root,
          replies: [reply],
          replyCount: 1,
        }),
        sendReply: async (args: SendReplyArgs) => {
          sent.push(args);
        },
      },
    });
    await tick();
    await Promise.resolve();
    await tick();

    const composer = h.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    composer.value = "@Stefan";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const picker = h.querySelector(
      '[data-testid="mention-picker"]',
    ) as HTMLElement | null;
    expect(picker).not.toBeNull();
    expect(picker?.textContent).toContain("Stefan Johnson");

    const row = h.querySelector(".mention-row") as HTMLButtonElement | null;
    expect(row).not.toBeNull();
    row!.click();
    await tick();
    expect(composer.value).toContain("@Stefan Johnson");

    const sendBtn = h.querySelector(
      '[data-testid="reply-panel-send"]',
    ) as HTMLButtonElement;
    sendBtn.click();
    await tick();
    await Promise.resolve();
    await tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe("@Stefan Johnson");
    expect(sent[0]?.mentions).toEqual([
      {
        participantUid: "prs_stefan",
        participantType: "human",
        displayName: "Stefan Johnson",
        email: "stefan@getindigo.ai",
      },
    ]);
  });
});
