// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { ConversationRow } from "./sidebar-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

describe("ChatSidebar new-message modal", () => {
  it("opens the picked conversation instead of only closing", async () => {
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
    const onselect = vi.fn<(row: ConversationRow) => void>();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: createFixtureChatSidebarApi(),
        seedDirectory: [
          {
            channelId: "hq-desktop",
            name: "hq-desktop",
            scope: "company",
            lastActivityAt: new Date().toISOString(),
          },
        ],
        onselect,
      },
    });

    await tick();
    await tick();
    const open = (host.querySelector('[data-testid="chat-new-message"]') ??
      host.querySelector(
        '[aria-label="New message"]',
      )) as HTMLButtonElement | null;
    expect(open).toBeTruthy();
    open?.click();
    await tick();

    // Modal is portaled to .desktop-shell or document.body.
    const modal = document.querySelector(
      '[data-testid="chat-new-message-modal"]',
    );
    expect(modal).toBeTruthy();
    const suggestion = document.querySelector(
      '[data-testid="chat-compose-suggestion"]',
    ) as HTMLButtonElement | null;
    expect(suggestion).toBeTruthy();
    suggestion?.click();
    await tick();

    (
      document.querySelector(
        '[data-testid="chat-compose-send"]',
      ) as HTMLButtonElement
    )?.click();
    await tick();

    expect(onselect).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="chat-new-message-modal"]'),
    ).toBeNull();
  });

  it("excludes the synthetic #setup channel from compose suggestions", async () => {
    // Regression: the pinned #setup row sits first in the rail, so with an
    // empty (or not-yet-debounced) query it used to be the FIRST compose
    // suggestion — a fast type-then-send misrouted the draft to channelId
    // "setup" instead of the intended conversation (US-103 compose test).
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: createFixtureChatSidebarApi(),
        seedDirectory: [
          {
            channelId: "chn_existing",
            name: "existing",
            scope: "company",
            lastActivityAt: new Date().toISOString(),
          },
        ],
      },
    });
    await tick();
    await tick();

    (
      host.querySelector('[data-testid="chat-new-message"]') as HTMLButtonElement
    )?.click();
    await tick();

    const suggestions = Array.from(
      document.querySelectorAll('[data-testid="chat-compose-suggestion"]'),
    );
    expect(suggestions.length).toBeGreaterThan(0);
    for (const node of suggestions) {
      expect(node.textContent).not.toMatch(/#?\bsetup\b/i);
    }
  });

  it("offers create-channel for an unknown channel name and sends the draft as the first message", async () => {
    host = document.createElement("div");
    host.className = "desktop-shell chat-shell";
    document.body.appendChild(host);
    const createChannel = vi.fn(async () => ({ channelId: "chn_new" }));
    const sendChannelMessage = vi.fn(async () => {});
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...createFixtureChatSidebarApi(),
          createChannel,
          sendChannelMessage,
        },
        seedDirectory: [
          {
            channelId: "hq-desktop",
            name: "hq-desktop",
            scope: "company",
            lastActivityAt: new Date().toISOString(),
          },
        ],
      },
    });

    await tick();
    await tick();
    // canCreateChannel → the "+" button opens a menu; pick "New message".
    (
      host.querySelector(
        '[data-testid="chat-new-message"]',
      ) as HTMLButtonElement
    )?.click();
    await tick();
    (
      host.querySelector(
        '[data-testid="chat-plus-new-message"]',
      ) as HTMLButtonElement
    )?.click();
    await tick();

    const to = document.querySelector(
      '[data-testid="chat-compose-to"]',
    ) as HTMLInputElement;
    expect(to).toBeTruthy();
    to.value = "#launch-party";
    to.dispatchEvent(new Event("input", { bubbles: true }));
    const body = document.querySelector(
      '[data-testid="chat-compose-body"]',
    ) as HTMLTextAreaElement;
    body.value = "kicking this off";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    // Wait out the 110ms query debounce so the create row appears.
    await new Promise((r) => setTimeout(r, 150));
    await tick();

    const createRow = document.querySelector(
      '[data-testid="chat-compose-create-channel"]',
    ) as HTMLButtonElement | null;
    expect(createRow?.textContent).toContain("launch-party");
    createRow?.click();
    await tick();

    // Handed off to the New-channel modal with the name pre-filled.
    const nameInput = document.querySelector(
      '[data-testid="chat-channel-name"]',
    ) as HTMLInputElement | null;
    expect(nameInput?.value).toBe("launch-party");
    (
      document.querySelector(
        '[data-testid="chat-channel-create"]',
      ) as HTMLButtonElement | null
    )?.click();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await tick();

    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "launch-party" }),
    );
    expect(sendChannelMessage).toHaveBeenCalledWith({
      channelId: "chn_new",
      body: "kicking this off",
    });
    // The new channel is in the rail immediately (optimistic upsert).
    expect(host.textContent).toContain("launch-party");
  });
});
