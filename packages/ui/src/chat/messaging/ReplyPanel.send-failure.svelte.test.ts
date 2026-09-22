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
  fromPersonUid: "prs_stefan",
  fromDisplayName: "Stefan Johnson",
  body: "GA testing thread",
  createdAt: "2026-09-18T22:00:00.000Z",
};

function api(sendReply: ConversationApi["sendReply"]): ConversationApi {
  return {
    fetchReplyThread: async () => ({
      scope: "channel",
      root,
      replies: [],
      replyCount: 0,
    }),
    sendReply,
  } as unknown as ConversationApi;
}

async function mountPanel(sendReply: ConversationApi["sendReply"]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: api(sendReply),
      rootEventId: "evt_root",
      scope: "channel",
      channelId: "chn_1",
      seedRoot: root,
      selfDisplayName: "Corey",
      onclose: () => {},
    },
  });
  for (let i = 0; i < 4; i++) {
    await tick();
    await Promise.resolve();
  }
}

async function typeAndSend(text: string): Promise<void> {
  const composer = host.querySelector(
    '[data-testid="reply-panel-composer"]',
  ) as HTMLTextAreaElement;
  composer.value = text;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  composer.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
}

/**
 * Regression (owner report, 2026-09-18): a thread reply whose @mentions the
 * channel refuses failed with a bare "Failed — tap to retry". The retry replays
 * the identical payload, so it can never succeed, and nothing told the user
 * which name was the problem.
 */
describe("ReplyPanel send failures", () => {
  it("shows the reason and no retry when the server refuses the request", async () => {
    const sendReply = vi.fn(async () => {
      throw new Error(
        "[MENTION_PARTICIPANT_NOT_VISIBLE] Mentioned participant is not active in this company",
      );
    });
    await mountPanel(sendReply as unknown as ConversationApi["sendReply"]);
    await typeAndSend("please look at this");

    expect(sendReply).toHaveBeenCalledTimes(1);
    const failure = host.querySelector(
      '[data-testid="reply-panel-send-error"]',
    );
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain("isn't active in this company");
    expect(failure?.tagName).toBe("SPAN");
    expect(host.querySelector('[data-testid="reply-panel-retry"]')).toBeNull();
  });

  it("keeps the retry for a transient network failure", async () => {
    const sendReply = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    await mountPanel(sendReply as unknown as ConversationApi["sendReply"]);
    await typeAndSend("still here?");

    const retry = host.querySelector(
      '[data-testid="reply-panel-retry"]',
    ) as HTMLButtonElement | null;
    expect(retry).not.toBeNull();
    expect(retry?.textContent).toContain("Tap to retry.");
    expect(host.querySelector('[data-testid="reply-panel-send-error"]')).toBeNull();
  });
});
