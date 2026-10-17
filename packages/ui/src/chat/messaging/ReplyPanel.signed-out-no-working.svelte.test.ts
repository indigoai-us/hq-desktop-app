// @vitest-environment happy-dom

/**
 * A thread in a local bot's DM shows no "is thinking" line for a reply while
 * the bot's coding tool is signed out here, and shows it once the tool signs in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import type { ConversationApi } from "../chat-api";

const BOT_UID = "agt_LOCAL000000000000000000001";

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
  fromPersonUid: BOT_UID,
  fromDisplayName: "setup",
  body: "Hi",
  createdAt: "2026-09-15T09:00:00.000Z",
};

function api(): ConversationApi {
  return {
    fetchReplyThread: async () => ({ scope: "dm", root, replies: [], replyCount: 0 }),
    sendReply: async () => ({}),
  } as unknown as ConversationApi;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function mountPanel(signedOut: { value: boolean }, scope: "dm" | "channel" = "dm"): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: api(),
      rootEventId: "evt_root",
      scope,
      channelId: scope === "channel" ? "chn_1" : null,
      withPersonUid: scope === "dm" ? BOT_UID : null,
      withPersonName: "setup",
      seedRoot: root,
      onclose: () => {},
      agentSignedOut: (uid: string) => uid === BOT_UID && signedOut.value,
    },
  });
  return host;
}

async function reply(h: HTMLDivElement, text: string): Promise<void> {
  const composer = h.querySelector<HTMLTextAreaElement>('[data-testid="reply-panel-composer"]');
  expect(composer).not.toBeNull();
  composer!.value = text;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  h.querySelector<HTMLButtonElement>('[data-testid="reply-panel-send"]')!.click();
  await settle();
}

const thinkingRow = (h: HTMLDivElement) => h.querySelector<HTMLElement>('[data-testid="agent-thinking-row"]');

describe("ReplyPanel signed-out bot shows no working line", () => {
  it("hides the row for a reply while signed out and shows it once the tool signs in", async () => {
    const signedOut = $state({ value: true });
    const h = mountPanel(signedOut);
    await settle();

    await reply(h, "hello");
    expect(thinkingRow(h)).toBeNull();
    expect(h.textContent).not.toContain("is thinking");

    signedOut.value = false;
    await settle();
    expect(thinkingRow(h)?.textContent).toContain("is thinking");
  });

  it("shows the row for a reply when the bot's tool is signed in", async () => {
    const signedOut = $state({ value: false });
    const h = mountPanel(signedOut);
    await settle();

    await reply(h, "hello");
    expect(thinkingRow(h)?.textContent).toContain("is thinking");
  });
});
