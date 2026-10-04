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
 * B-10: while a cloud bot's channel is open and its setup is not finished,
 * the app reads the bot's status to know when the composer can unlock. That
 * read repeated every 5 s for as long as the channel stayed open, whatever
 * came back: a failed setup, a removed bot, a refused read.
 */

const ADA = "agt_ada";
const CHANNEL: ConversationRow = { id: "ch:chn_ada", kind: "channel", title: "ada", channelId: "chn_ada" } as ConversationRow;

/** The bot's channel: its setup card is still pending. Newest first. */
const MESSAGES = [
  {
    eventId: "c2",
    fromPersonUid: "sys_hq",
    fromDisplayName: "HQ",
    body: "",
    createdAt: "2026-10-02T13:54:20.000Z",
    systemEvent: {
      type: "lifecycle_card",
      kind: "status",
      state: "pending",
      cardId: "card_status_ada",
      fields: [
        { id: "summary", value: "Provisioning Ada…" },
        { id: "agentUid", value: ADA },
      ],
    },
  },
  { eventId: "c1", fromPersonUid: "prs_me", fromDisplayName: "Corey", body: "Welcome Ada", createdAt: "2026-10-02T13:53:50.000Z" },
];

type StatusResult = Awaited<ReturnType<PlatformAdapter["agents"]["getStatus"]>>;
const notReady = (): StatusResult => ok({ setupState: { phase: "installing", steps: [] } }) as StatusResult;
const failure = (code: string): StatusResult => ({ ok: false, reason: "error", code, message: "no" }) as unknown as StatusResult;

function adapter(getStatus: () => Promise<StatusResult>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [{ personUid: ADA, displayName: "Ada" }] }),
      fetchChannel: async () => ok({ messages: MESSAGES, nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [] }),
    },
    agents: { getStatus },
    settings: { getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }) },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage.clear();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountChannel(getStatus: ReturnType<typeof vi.fn>): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(getStatus as unknown as () => Promise<StatusResult>),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey Epstein", email: "me@example.com" },
      initialRow: CHANNEL,
      wakes: createChatWakeBus(),
      coreFixtures: false,
    },
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="conversation-thread"]')?.textContent ?? "").toContain("Welcome Ada"));
  await vi.waitFor(() => expect(getStatus).toHaveBeenCalled());
  await settle();
}

async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

describe("DesktopApp: the readiness read in a cloud bot's channel", () => {
  it("keeps asking every 5 s while the bot is not ready to chat", async () => {
    const getStatus = vi.fn(async () => notReady());
    await mountChannel(getStatus);
    const before = getStatus.mock.calls.length;
    await pass(31_000);
    // Six more in half a minute, as before.
    expect(getStatus.mock.calls.length - before).toBeGreaterThanOrEqual(5);
    expect(getStatus.mock.calls.every(([uid]) => uid === ADA)).toBe(true);
  });

  it("stops once the status says the setup failed", async () => {
    const getStatus = vi.fn(async () => ok({ setupState: { phase: "failed", steps: [] } }) as StatusResult);
    await mountChannel(getStatus);
    const before = getStatus.mock.calls.length;
    await pass(120_000);
    expect(getStatus.mock.calls.length).toBe(before);
  });

  it("stops when the server refuses the read or does not know the bot", async () => {
    for (const code of ["http-403", "http-404", "http-401"]) {
      const getStatus = vi.fn(async () => failure(code));
      await mountChannel(getStatus);
      const before = getStatus.mock.calls.length;
      await pass(120_000);
      expect(getStatus.mock.calls.length, code).toBe(before);
      if (component) await unmount(component);
      component = null;
      host.remove();
      vi.useRealTimers();
    }
  });

  it("asks less often each time the read keeps failing, and goes back to 5 s when one succeeds", async () => {
    let fail = true;
    const getStatus = vi.fn(async () => (fail ? failure("http-500") : notReady()));
    await mountChannel(getStatus);
    const first = getStatus.mock.calls.length;
    // 10 s, then 20 s, then 40 s: three more reads in 71 s. The fixed timer made fourteen.
    await pass(71_000);
    expect(getStatus.mock.calls.length - first).toBe(3);
    // A read that throws counts the same way: the next one is 80 s out.
    getStatus.mockImplementation(async () => {
      throw new Error("offline");
    });
    await pass(75_000);
    expect(getStatus.mock.calls.length - first).toBe(3);
    await pass(6_000);
    expect(getStatus.mock.calls.length - first).toBe(4);

    // The server answers again: back to the usual timer.
    fail = false;
    getStatus.mockImplementation(async () => notReady());
    await pass(161_000);
    const afterRecovery = getStatus.mock.calls.length;
    await pass(16_000);
    expect(getStatus.mock.calls.length - afterRecovery).toBeGreaterThanOrEqual(3);
  });
});
