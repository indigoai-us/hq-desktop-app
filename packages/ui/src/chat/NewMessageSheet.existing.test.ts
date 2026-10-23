// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import NewMessageSheet from "./NewMessageSheet.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { ConversationRow } from "./sidebar-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const base = { companyUid: null, unreadDot: false, lastActivityAt: 0, pinned: false };
const ADA = { ...base, id: "dm:prs_ada", kind: "dm", title: "Ada", personUid: "prs_ada" } as ConversationRow;
const BOB = { ...base, id: "dm:prs_bob", kind: "dm", title: "Bob", personUid: "prs_bob" } as ConversationRow;
const GROUP = {
  ...base,
  id: "ch:g1",
  kind: "group",
  title: "Ada, Bob",
  channelId: "g1",
  lastActivityAt: Date.now() - 3 * 3_600_000,
  members: [
    { personUid: "prs_me", displayName: "Me" },
    { personUid: "prs_ada", displayName: "Ada" },
    { personUid: "prs_bob", displayName: "Bob" },
  ],
} as ConversationRow;

// iOS #44: picking people you already have a conversation with shows that
// conversation and sends there, instead of starting a duplicate group.
describe("NewMessageSheet with an existing conversation", () => {
  it("offers the existing group and sends to it rather than creating one", async () => {
    const api = {
      createChannel: vi.fn(),
      sendChannelMessage: vi.fn(async () => {}),
      listContacts: vi.fn(async () => ({ contacts: [] })),
    } as unknown as ChatSidebarApi;
    const onopen = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NewMessageSheet, {
      target: host,
      props: { api, rows: [ADA, BOB, GROUP], contacts: [], companies: [], onclose: vi.fn(), onopen },
    });
    await tick();
    for (const id of ["dm:prs_ada", "dm:prs_bob"]) {
      host.querySelector<HTMLButtonElement>(`[data-testid="recipient-row"][data-id="${id}"]`)!.click();
      flushSync();
    }
    const card = host.querySelector('[data-testid="new-message-existing"]');
    expect(card?.textContent).toContain("Ada, Bob");
    expect(card?.textContent).toContain("You already have this conversation");

    const body = host.querySelector<HTMLTextAreaElement>('[data-testid="new-message-body"]')!;
    body.value = "hello both";
    body.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="new-message-send"]')!.click();
    await vi.waitFor(() => expect(onopen).toHaveBeenCalledWith(GROUP));
    expect(api.sendChannelMessage).toHaveBeenCalledWith({ channelId: "g1", body: "hello both" });
    expect(api.createChannel).not.toHaveBeenCalled();
  });

  it("opens the existing conversation from the card", async () => {
    const onopen = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(NewMessageSheet, {
      target: host,
      props: {
        api: { listContacts: vi.fn(async () => ({ contacts: [] })) } as unknown as ChatSidebarApi,
        rows: [ADA],
        contacts: [],
        companies: [],
        onclose: vi.fn(),
        onopen,
      },
    });
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="recipient-row"][data-id="dm:prs_ada"]')!.click();
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="new-message-existing"]')!.click();
    expect(onopen).toHaveBeenCalledWith(ADA);
  });
});
