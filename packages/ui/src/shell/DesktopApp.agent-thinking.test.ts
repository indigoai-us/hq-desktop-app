// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { MentionTarget } from "../chat/mentions.js";

/** Mutable channel timeline the fake adapter serves — the test appends the
 *  agent's reply here, then fires a channel wake to deliver it. */
interface Fixture {
  messages: Array<Record<string, unknown>>;
  failSend: boolean;
}

function adapter(fx: Fixture): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [...fx.messages].reverse() }),
      sendChannelMessage: async () =>
        fx.failSend
          ? { ok: false as const, reason: "unavailable", message: "nope" }
          : ok({
              eventId: "evt_self_1",
              createdAt: new Date().toISOString(),
            }),
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
    },
  } as unknown as PlatformAdapter;
}

const CHANNEL_ROW: ConversationRow = {
  id: "ch:chn_test",
  kind: "channel",
  title: "general",
  channelId: "chn_test",
} as ConversationRow;

const IZZY: MentionTarget = {
  participantUid: "agt_izzy",
  participantType: "agent",
  displayName: "Izzy",
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(fx: Fixture, wakes = createChatWakeBus()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: CHANNEL_ROW,
      mentionCandidates: [IZZY],
      wakes,
      coreFixtures: false,
    },
  });
  await settle();
  return wakes;
}

/** Drive the real composer: type an @mention, pick Izzy from the picker,
 *  then Enter-send — same payload path a user produces. */
async function sendMentionMessage(): Promise<void> {
  const composer = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(composer, "live composer renders for the channel row").toBeTruthy();
  composer!.value = "@Izzy";
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  const pick = host.querySelector<HTMLButtonElement>(
    '[data-testid="mention-picker"] button',
  );
  expect(pick, "mention picker offers the agent").toBeTruthy();
  pick!.click();
  await settle();
  composer!.value = `${composer!.value} take a look`;
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  composer!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await settle(10);
}

describe("DesktopApp agent thinking indicator", () => {
  it("shows a thinking row after a successful @agent channel send and clears it when the agent replies", async () => {
    const fx: Fixture = { messages: [], failSend: false };
    const wakes = await mountApp(fx);
    await sendMentionMessage();

    const row = host.querySelector('[data-testid="agent-thinking-row"]');
    expect(row, "thinking row renders beneath the conversation").toBeTruthy();
    expect(row?.textContent).toContain("Izzy is thinking");
    // Placement regression (owner bug): the row must live INSIDE the
    // conversation scroller, after the messages — never as a chat-stage
    // sibling, which the horizontal flex lays out as a floating top-right
    // column outside the conversation.
    expect(
      row?.closest('[data-testid="conversation-thread"]'),
      "row is inside the conversation scroll flow",
    ).toBeTruthy();

    // Agent reply lands via a channel wake → timeline catch-up → clear.
    fx.messages.push({
      eventId: "evt_izzy_1",
      body: "On it.",
      fromPersonUid: "agt_izzy",
      fromDisplayName: "Izzy",
      createdAt: new Date().toISOString(),
      direction: "in",
    });
    wakes.emit("channel:new-message", {
      channelId: "chn_test",
      eventId: "evt_izzy_1",
      createdAt: new Date().toISOString(),
    });
    await settle(10);

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "agent reply clears the row",
    ).toBeNull();
  });

  it("does not leave a thinking row behind when the send fails", async () => {
    const fx: Fixture = { messages: [], failSend: true };
    await mountApp(fx);
    await sendMentionMessage();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "failed send never shows an optimistic row",
    ).toBeNull();
  });
});
