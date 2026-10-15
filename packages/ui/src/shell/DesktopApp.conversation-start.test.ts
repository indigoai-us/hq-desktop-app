// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { CONVERSATION_START_KEY } from "../chat/first-run/conversation-start.js";

/**
 * Owner decision, 2026-10-15: a fresh install that names the account's one
 * assistant adopts it, and the person lands in a fresh conversation. On the
 * test VM the renamed assistant's DM showed the earlier install's messages
 * ("hi Nibs", 3:06 PM to 4:09 PM). With the conversation start recorded at
 * adopt time, only messages from then on render; with none, nothing changes.
 */

/** Newest first, as the server returns a direct-message page. */
const THREAD = [
  { eventId: "n1", fromPersonUid: "agt_nibs", fromDisplayName: "Nibs", body: "Hi, I'm Nibs on this computer now.", createdAt: "2026-10-15T16:30:05.000Z" },
  { eventId: "o2", fromPersonUid: "agt_nibs", fromDisplayName: "Nibs", body: "Earlier answer from the old install.", createdAt: "2026-10-15T16:09:00.000Z" },
  { eventId: "o1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "hi Nibs", createdAt: "2026-10-15T15:06:00.000Z" },
];

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: THREAD }),
    },
    agents: {
      getStatus: async () => ok({ setupState: { phase: "ready" }, agent: { runtime: { syncOkAt: "2026-10-15T16:20:00.000Z" } } }),
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

beforeEach(() => localStorage.clear());
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  localStorage.clear();
});

async function openNibsDm(): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const row = { id: "dm:agt_nibs", kind: "dm", title: "Nibs", personUid: "agt_nibs", companyUid: null } as ConversationRow;
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: row,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  const thread = (): string => host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "";
  await vi.waitFor(() => expect(thread()).toContain("on this computer now"));
  for (let i = 0; i < 10; i += 1) {
    await tick();
    await Promise.resolve();
  }
  return thread();
}

describe("DesktopApp first-run assistant conversation start", () => {
  it("shows only the messages from the recorded start on", async () => {
    localStorage.setItem(CONVERSATION_START_KEY, JSON.stringify({ agt_nibs: Date.parse("2026-10-15T16:30:00.000Z") }));
    const text = await openNibsDm();
    expect(text).toContain("Hi, I'm Nibs on this computer now.");
    expect(text).not.toContain("hi Nibs");
    expect(text).not.toContain("Earlier answer from the old install.");
  });

  it("shows the whole conversation when no start is recorded", async () => {
    const text = await openNibsDm();
    expect(text).toContain("Hi, I'm Nibs on this computer now.");
    expect(text).toContain("hi Nibs");
    expect(text).toContain("Earlier answer from the old install.");
  });
});
