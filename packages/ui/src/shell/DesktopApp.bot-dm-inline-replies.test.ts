// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/**
 * Owner walkthrough, 2026-10-02: a hosted bot answered in a thread, so its
 * answer sat under "1 reply" while the conversation looked silent. "See how
 * sheister replies in a DM? That's the flow we want." Hosted bots post every
 * answer as a reply to the message that triggered it; a one-to-one
 * conversation with a bot shows those answers in line.
 */

/** Newest first, as the server returns a direct-message page. */
const THREAD = [
  { eventId: "e4", fromPersonUid: "agt_nova", fromDisplayName: "Nova", body: "Here now. What do you need?", createdAt: "2026-10-02T13:55:10.000Z", rootEventId: "e3" },
  { eventId: "e3", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Hello there", createdAt: "2026-10-02T13:54:50.000Z", replyCount: 1 },
  { eventId: "e2", fromPersonUid: "agt_nova", fromDisplayName: "Nova", body: "Hi Corey, I am Nova.", createdAt: "2026-10-02T13:54:20.000Z", rootEventId: "e1" },
  { eventId: "e1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Automatic message from HQ: your setup has just finished", createdAt: "2026-10-02T13:53:50.000Z", audience: "agent", replyCount: 1 },
];

function adapter(peerUid: string): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () =>
        ok({ messages: THREAD.map((row) => (row.fromPersonUid === "agt_nova" ? { ...row, fromPersonUid: peerUid } : row)) }),
    },
    agents: {
      getStatus: async () => ok({ setupState: { phase: "ready" }, agent: { runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" } } }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountDm(peerUid: string, seeded: Array<Record<string, unknown>> = []): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const row = { id: `dm:${peerUid}`, kind: "dm", title: "Nova", personUid: peerUid, companyUid: null } as ConversationRow;
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(peerUid),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: row,
      ...(seeded.length > 0 ? { messagesByRow: () => seeded as never } : {}),
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  const thread = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
  await vi.waitFor(() => expect(thread()).toContain("Hello there"));
  await settle();
  return thread();
}

describe("DesktopApp direct message with a bot", () => {
  it("shows the bot's answers in line, not under a reply count", async () => {
    const text = await mountDm("agt_nova");
    expect(text).toContain("Hello there");
    expect(text).toContain("Hi Corey, I am Nova.");
    expect(text).toContain("Here now. What do you need?");
    expect(text.indexOf("Hi Corey, I am Nova.")).toBeLessThan(text.indexOf("Hello there"));
    expect(text.indexOf("Hello there")).toBeLessThan(text.indexOf("Here now. What do you need?"));
    expect(text).not.toMatch(/\b1 reply\b/);
  });

  it("never shows the request the app sent the bot for its first message", async () => {
    const text = await mountDm("agt_nova");
    expect(text).not.toContain("Automatic message from HQ");
  });

  it("never shows that request when the host seeded the thread from its own store", async () => {
    // Regression (owner, 2026-10-02): the request was visible in the bot's
    // direct message. The host's stored rows carry no lane and were shown as
    // they were.
    const seeded = [...THREAD].reverse().map(({ audience: _lane, ...row }) => row);
    const text = await mountDm("agt_nova", seeded);
    expect(text).toContain("Hi Corey, I am Nova.");
    expect(text).not.toContain("Automatic message from HQ");
    expect(text).not.toMatch(/\b1 reply\b/);
  });

  it("keeps threads under their root in a conversation between two people", async () => {
    const text = await mountDm("prs_nova");
    expect(text).toContain("Hello there");
    expect(text).not.toContain("Here now. What do you need?");
    expect(text).toMatch(/1 reply/);
  });

  it("offers no 'Reply in thread' in a bot's direct message, where replies show in line (B-5)", async () => {
    await mountDm("agt_nova");
    expect(host.querySelectorAll('[data-testid="conversation-message"]').length).toBeGreaterThan(0);
    expect(host.querySelectorAll('[data-testid="message-reply-quick"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="message-replies"]')).toHaveLength(0);
    // The other message actions are still there.
    expect(host.querySelectorAll('[data-testid="message-copy"]').length).toBeGreaterThan(0);
  });

  it("still offers 'Reply in thread' between two people, and it opens the thread", async () => {
    await mountDm("prs_nova");
    const replies = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="message-reply-quick"]')];
    expect(replies.length).toBeGreaterThan(0);
    replies[0]!.click();
    await settle();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="reply-panel"]')).not.toBeNull());
  });
});

/**
 * B-1: only the app's own requests are left out of a bot conversation, and
 * nothing is left out anywhere else. The app's requests open with
 * "Automatic message from HQ:". A row is one of them when it is tagged for
 * the bot (`audience: "agent"`), or, for a stored copy with no tag, when the
 * signed-in person sent it. A bot's own row is never hidden, and no row is
 * hidden in a channel or in a conversation between two people.
 */
describe("DesktopApp: which rows opening with the app's words are hidden", () => {
  const LEAD = "Automatic message from HQ:";
  type Row = Record<string, unknown>;
  const row = (eventId: string, fromPersonUid: string, body: string, at: string, over: Row = {}): Row => ({
    eventId,
    fromPersonUid,
    fromDisplayName: fromPersonUid === "prs_me" ? "Corey" : fromPersonUid.startsWith("agt_") ? "Nova" : "Hassaan",
    body,
    createdAt: `2026-10-02T13:${at}.000Z`,
    ...over,
  });

  async function mountRows(input: {
    target: ConversationRow;
    /** Newest first, as the server returns a page. */
    page: Row[];
    seeded?: Row[];
    shows: string;
  }): Promise<string> {
    host = document.createElement("div");
    document.body.appendChild(host);
    const value = {
      kind: "web",
      isAvailable: () => false,
      capabilities: {},
      messaging: {
        listContacts: async () => ok({ contacts: [] }),
        listChannelMembers: async () => ok({ members: [] }),
        fetchChannel: async () => ok({ messages: input.page, nextCursor: null }),
        fetchDmThread: async () => ok({ messages: input.page }),
      },
      agents: {
        getStatus: async () => ok({ setupState: { phase: "ready" }, agent: { runtime: { syncOkAt: "2026-10-02T14:20:00.000Z" } } }),
      },
      settings: { getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }) },
      shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    } as unknown as PlatformAdapter;
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: value,
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
        initialRow: input.target,
        ...(input.seeded ? { messagesByRow: () => input.seeded as never } : {}),
        wakes: createChatWakeBus(),
        coreFixtures: false,
      },
    });
    const thread = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
    await vi.waitFor(() => expect(thread()).toContain(input.shows));
    await settle();
    return thread();
  }

  const BOT_DM = { id: "dm:agt_nova", kind: "dm", title: "Nova", personUid: "agt_nova", companyUid: null } as ConversationRow;
  const PERSON_DM = { id: "dm:prs_hassaan", kind: "dm", title: "Hassaan", personUid: "prs_hassaan", companyUid: null } as ConversationRow;
  const CHANNEL = { id: "ch:chn_general", kind: "channel", title: "general", channelId: "chn_general" } as ConversationRow;

  it("shows a bot's own message that opens with the app's words, in its direct message", async () => {
    const text = await mountRows({
      target: BOT_DM,
      shows: "Hello there",
      page: [
        row("e4", "agt_nova", `${LEAD} this is what the request I got said. Here is my answer.`, "55:10"),
        row("e3", "prs_me", "Hello there", "54:50"),
        row("e2", "agt_nova", `${LEAD} quoted by the bot as a reply`, "54:20", { rootEventId: "e1" }),
        row("e1", "prs_me", `${LEAD} your setup has just finished`, "53:50", { audience: "agent", replyCount: 1 }),
      ],
    });
    expect(text).toContain(`${LEAD} this is what the request I got said. Here is my answer.`);
    expect(text).toContain(`${LEAD} quoted by the bot as a reply`);
    // The app's own request, sent for the person on the bot's lane, stays out.
    expect(text).not.toContain("your setup has just finished");
  });

  it("in a bot's direct message, hides a stored copy with no tag only when the signed-in person sent it", async () => {
    // The host's stored thread keeps no lane. The viewer's own copy of the
    // request is hidden; a row from anyone else is not the app's request.
    const seeded = [
      row("e1", "prs_me", `${LEAD} your setup has just finished`, "53:50"),
      row("e2", "agt_nova", "Hi Corey, I am Nova.", "54:20"),
      row("e3", "prs_someone_else", `${LEAD} written by another account`, "54:40"),
      row("e4", "prs_me", "Hello there", "54:50"),
    ];
    const text = await mountRows({ target: BOT_DM, shows: "Hello there", page: [], seeded });
    expect(text).toContain("Hi Corey, I am Nova.");
    expect(text).toContain(`${LEAD} written by another account`);
    expect(text).not.toContain("your setup has just finished");
  });

  it("shows every row in a conversation between two people, whoever sent it", async () => {
    const text = await mountRows({
      target: PERSON_DM,
      shows: "Hello there",
      page: [
        row("e3", "prs_me", "Hello there", "54:50"),
        row("e2", "prs_me", `${LEAD} I typed this myself`, "54:20"),
        row("e1", "prs_hassaan", `${LEAD} and Hassaan typed this`, "53:50", { audience: "agent" }),
      ],
    });
    expect(text).toContain(`${LEAD} I typed this myself`);
    expect(text).toContain(`${LEAD} and Hassaan typed this`);
  });

  it("shows every row in a channel, whoever sent it", async () => {
    const text = await mountRows({
      target: CHANNEL,
      shows: "Morning all",
      page: [
        row("c4", "prs_me", "Morning all", "55:10"),
        row("c3", "agt_nova", `${LEAD} a bot wrote this in the channel`, "54:50"),
        row("c2", "prs_hassaan", `${LEAD} a teammate wrote this`, "54:20", { audience: "agent" }),
        row("c1", "prs_me", `${LEAD} I wrote this`, "53:50"),
      ],
    });
    expect(text).toContain(`${LEAD} a bot wrote this in the channel`);
    expect(text).toContain(`${LEAD} a teammate wrote this`);
    expect(text).toContain(`${LEAD} I wrote this`);
  });
});
