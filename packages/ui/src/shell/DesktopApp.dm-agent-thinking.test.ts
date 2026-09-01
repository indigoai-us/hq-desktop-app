// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/** Mutable DM timeline the fake adapter serves — the test appends the
 *  agent's reply here, then fires a mesh catch-up to deliver it. */
interface Fixture {
  messages: Array<Record<string, unknown>>;
  failSend: boolean;
  toggleReaction: ReturnType<typeof vi.fn>;
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
      fetchDmThread: async () =>
        ok({ messages: [...fx.messages].reverse() }),
      sendDm: async () =>
        fx.failSend
          ? { ok: false as const, reason: "unavailable", message: "nope" }
          : ok({
              eventId: "evt_self_1",
              createdAt: new Date().toISOString(),
            }),
      sendChannelMessage: async () =>
        ok({
          eventId: "evt_self_1",
          createdAt: new Date().toISOString(),
        }),
      toggleReaction: fx.toggleReaction,
      fetchReactions: async () => ok({ reactions: [] }),
    },
    notifications: {
      fetchDmInbox: async () => ok({}),
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

const DM_ROW = {
  id: "dm:agt_izzy",
  kind: "dm",
  title: "Izzy",
  personUid: "agt_izzy",
} as ConversationRow;

const HUMAN_ROW = {
  id: "dm:prs_someone",
  kind: "dm",
  title: "Dana",
  personUid: "prs_someone",
} as ConversationRow;

function createFx(overrides: Partial<Fixture> = {}): Fixture {
  return {
    messages: [],
    failSend: false,
    toggleReaction: vi.fn(async () => ok(undefined)),
    ...overrides,
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  vi.useRealTimers();
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

async function mountApp(
  fx: Fixture,
  wakes = createChatWakeBus(),
  row: ConversationRow = DM_ROW,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(fx),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      initialRow: row,
      wakes,
      coreFixtures: false,
    },
  });
  await settle();
  return wakes;
}

/** Drive the real composer: type plain text, then Enter-send — same payload
 *  path a user produces. DMs with an agent do not require an @mention. */
async function sendPlainMessage(): Promise<void> {
  const composer = host.querySelector<HTMLTextAreaElement>(
    '[data-testid="conversation-composer"]',
  );
  expect(composer, "live composer renders for the DM row").toBeTruthy();
  composer!.value = "hey";
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await settle(10);
}

describe("DesktopApp agent DM thinking indicator", () => {
  it("starts a thinking row on a plain DM send to an agent", async () => {
    const fx = createFx();
    await mountApp(fx);
    await sendPlainMessage();

    const row = host.querySelector('[data-testid="agent-thinking-row"]');
    expect(row, "thinking row renders beneath the conversation").toBeTruthy();
    expect(row?.textContent).toContain("Izzy is thinking");
    expect(
      row?.closest('[data-testid="conversation-thread"]'),
      "row is inside the conversation scroll flow",
    ).toBeTruthy();
  });

  it("does not start a row in a DM with a human", async () => {
    const fx = createFx();
    await mountApp(fx, createChatWakeBus(), HUMAN_ROW);
    await sendPlainMessage();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "human DMs never show an agent thinking row",
    ).toBeNull();
  });

  it("clears the row when the agent replies", async () => {
    const fx = createFx();
    const wakes = await mountApp(fx);
    await sendPlainMessage();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "thinking row is up before the reply",
    ).toBeTruthy();

    fx.messages.push({
      eventId: "evt_izzy_1",
      body: "On it.",
      fromPersonUid: "agt_izzy",
      fromDisplayName: "Izzy",
      createdAt: new Date().toISOString(),
      direction: "in",
    });
    wakes.emit("mesh:catchup", {} as { reason: "connect" | "focus" });
    await settle(10);

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "agent reply clears the row",
    ).toBeNull();
  });

  it("retires the row after the hard expiry", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    const fx = createFx();
    await mountApp(fx);
    await sendPlainMessage();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "thinking row is up before expiry",
    ).toBeTruthy();

    vi.setSystemTime(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "hard expiry drops the row",
    ).toBeNull();
  });

  it("drops the row when the DM send fails", async () => {
    const fx = createFx({ failSend: true });
    await mountApp(fx);
    await sendPlainMessage();

    expect(
      host.querySelector('[data-testid="agent-thinking-row"]'),
      "failed send never shows an optimistic row",
    ).toBeNull();
  });

  it("toggles a reaction on a DM message with the dm message scope", async () => {
    const fx = createFx({
      messages: [
        {
          eventId: "evt_seed_1",
          body: "hello",
          fromPersonUid: "agt_izzy",
          fromDisplayName: "Izzy",
          createdAt: "2026-08-01T00:00:00.000Z",
          direction: "in",
        },
      ],
    });
    await mountApp(fx);

    const react = await vi.waitFor(() => {
      const btn = host.querySelector<HTMLButtonElement>(
        '[aria-label="React with 👍"]',
      );
      expect(btn, "quick-react button is in the conversation").toBeTruthy();
      return btn!;
    });
    expect(
      host.querySelector('[data-testid="message-react-more"]'),
      "more-reactions picker trigger is in the conversation",
    ).toBeTruthy();
    react.click();
    await settle(10);

    expect(fx.toggleReaction).toHaveBeenCalled();
    expect(fx.toggleReaction.mock.calls[0]?.[0]?.messageScope).toBe(
      "dm:agt_izzy",
    );
  });
});
