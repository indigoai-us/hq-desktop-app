// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ReplyPanel from "./ReplyPanel.svelte";
import { resetThreadComposerDrafts } from "./thread-composer-draft.js";
import type { ConversationApi, ConversationMessageWire } from "../chat-api";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetThreadComposerDrafts();
  document
    .querySelectorAll('[data-testid="link-context-menu"]')
    .forEach((node) => node.remove());
});

const seed = (eventId: string, body = "root"): ConversationMessageWire => ({
  eventId,
  body,
  createdAt: "2026-08-17T01:00:00.000Z",
  fromDisplayName: "Ada",
  replyCount: 0,
});

function apiFor(root: ConversationMessageWire): ConversationApi {
  return {
    fetchReplyThread: async () => ({
      scope: "channel",
      root,
      replies: [],
      replyCount: 0,
    }),
    sendReply: async () => ({}),
  } as unknown as ConversationApi;
}

async function mountPanel(
  rootEventId: string,
  props: Record<string, unknown> = {},
): Promise<{ onclose: ReturnType<typeof vi.fn> }> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const onclose = vi.fn();
  const root = seed(
    rootEventId,
    (props.body as string | undefined) ?? "see https://example.com/docs",
  );
  component = mount(ReplyPanel, {
    target: host,
    props: {
      api: apiFor(root),
      rootEventId,
      scope: "channel",
      channelId: "chn_proj",
      seedRoot: root,
      onuploadfiles: async () => [],
      onclose,
      ...props,
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(host.querySelector('[data-testid="reply-panel-composer"]')).not.toBeNull();
  });
  return { onclose };
}

async function typeDraft(text: string): Promise<void> {
  const composer = host.querySelector(
    '[data-testid="reply-panel-composer"]',
  ) as HTMLTextAreaElement;
  composer.value = text;
  composer.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

describe("ReplyPanel drafts and Escape layers", () => {
  it("keeps an unsent draft and attachment for the thread and restores them on reopen", async () => {
    await mountPanel("evt_a");
    await typeDraft("hold this");
    const input = host.querySelector(
      '[data-testid="reply-panel-attach-input"]',
    ) as HTMLInputElement;
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    const list = new DataTransfer();
    list.items.add(file);
    input.files = list.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(host.querySelector('[data-testid="composer-file-chip"]')?.textContent).toContain(
      "note.txt",
    );

    await unmount(component!);
    component = null;
    host.remove();

    await mountPanel("evt_b");
    const other = host.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    expect(other.value).toBe("");
    expect(host.querySelector('[data-testid="composer-file-chip"]')).toBeNull();
    await unmount(component!);
    component = null;
    host.remove();

    await mountPanel("evt_a");
    const restored = host.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    expect(restored.value).toBe("hold this");
    expect(host.querySelector('[data-testid="composer-file-chip"]')?.textContent).toContain(
      "note.txt",
    );
  });

  it("Escape closes the reaction picker and leaves the thread open", async () => {
    const { onclose } = await mountPanel("evt_a");
    const add = host.querySelector(
      '[aria-label="Add a reaction"]',
    ) as HTMLButtonElement;
    expect(add).not.toBeNull();
    add.click();
    await tick();
    expect(host.querySelector(".emoji-picker")).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();

    expect(onclose).not.toHaveBeenCalled();
    expect(host.querySelector(".emoji-picker")).toBeNull();
    expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
  });

  it("Escape closes the link menu and leaves the thread open", async () => {
    const { onclose } = await mountPanel("evt_a");
    const anchor = host.querySelector(
      ".reply-md a[href]",
    ) as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    anchor!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 8,
      }),
    );
    await tick();
    expect(document.querySelector('[data-testid="link-context-menu"]')).not.toBeNull();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();

    expect(onclose).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="link-context-menu"]')).toBeNull();
    expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
  });

  it("Escape dismisses the mention picker and does not close the thread", async () => {
    const { onclose } = await mountPanel("evt_a", {
      mentionCandidates: [
        {
          participantUid: "prs_bea",
          participantType: "human",
          displayName: "Bea",
        },
      ],
    });
    await typeDraft("hi @Be");
    await tick();
    expect(host.querySelector('[data-testid="mention-picker"]')).not.toBeNull();

    const composer = host.querySelector(
      '[data-testid="reply-panel-composer"]',
    ) as HTMLTextAreaElement;
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();

    expect(onclose).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="mention-picker"]')).toBeNull();
    expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull();
  });
});
