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
});
