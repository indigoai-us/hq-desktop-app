// @vitest-environment happy-dom

/**
 * US-009 story acceptance: desktop card-action command + wake refresh.
 *
 * Failures render on the card (blocked + reason). Double-submit shares one
 * idempotency key. Card updates arrive through the existing wake bus and
 * re-fetch only the affected channel — including in-place same-eventId rewrites.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "../shell/DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import { createEmptyNotificationsApi } from "../shell/mesh-overlay.js";
import { createChatWakeBus } from "./chat-api.js";
import type { ConversationRow } from "./sidebar-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const CHANNEL_ROW: ConversationRow = {
  id: "ch:chn_setup",
  kind: "channel",
  title: "setup",
  channelId: "setup",
} as ConversationRow;

const OPEN_CARD = {
  v: 1,
  type: "lifecycle_card",
  cardId: "card_create_1",
  kind: "create_company",
  companyUid: null,
  state: "open" as "open" | "done" | "pending" | "blocked" | "skipped",
  title: "Name your company",
  fields: [
    {
      id: "name",
      label: "Company name",
      control: "text",
      required: true,
      value: "Ramen Bae",
    },
  ],
  actions: [{ id: "submit", label: "Create", style: "primary" }],
  viewer: { canAct: true },
};

function cardMessage(systemEvent: typeof OPEN_CARD) {
  return {
    eventId: "evt_lifecycle",
    direction: "in",
    fromDisplayName: "HQ",
    body: "",
    createdAt: "2026-09-02T14:12:00.000Z",
    messageKind: "system",
    systemEvent,
  };
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

async function mountApp(options: {
  runCardAction: PlatformAdapter["messaging"]["runCardAction"];
  fetchChannel: PlatformAdapter["messaging"]["fetchChannel"];
  wakes?: ReturnType<typeof createChatWakeBus>;
}): Promise<ReturnType<typeof createChatWakeBus>> {
  const wakes = options.wakes ?? createChatWakeBus();
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: {
        kind: "web",
        isAvailable: () => false,
        capabilities: {},
        messaging: {
          listContacts: async () => ok({ contacts: [] }),
          listChannelMembers: async () => ok({ members: [] }),
          fetchChannel: options.fetchChannel,
          sendChannelMessage: async () => ok({}),
          sendDm: async () => ok({}),
          fetchDmThread: async () => ok({ messages: [] }),
          fetchReplyThread: async () =>
            ok({ scope: "channel", root: null, replies: [], replyCount: 0 }),
          sendReply: async () => ok({}),
          runCardAction: options.runCardAction,
        },
        settings: {
          getSetupStatus: async () =>
            ok({
              hqRootValid: true,
              configured: true,
              hqFolderPath: "/tmp/HQ",
            }),
        },
        shell: {
          detectAiTools: async () => ({
            ok: false as const,
            reason: "unavailable",
          }),
        },
      } as unknown as PlatformAdapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_owner",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      initialRow: CHANNEL_ROW,
      wakes,
      hydrateLiveMessages: true,
      coreFixtures: false,
    },
  });
  await settle();
  await vi.waitFor(() => {
    expect(
      host.querySelector("[data-testid='lifecycle-card']"),
      "hydrated timeline includes the lifecycle card",
    ).toBeTruthy();
  });
  return wakes;
}

describe("US-009: Desktop card-action command and wake refresh", () => {
  it("Given the server returns 403, when the action is run, then the card shows the permission reason", async () => {
    const runCardAction = vi.fn(async () =>
      failure("LIFECYCLE_CARD_FORBIDDEN", "Viewer cannot act on this card"),
    );
    await mountApp({
      runCardAction,
      fetchChannel: async () =>
        ok({ messages: [cardMessage(OPEN_CARD)], nextCursor: null }),
    });

    const submit = host.querySelector<HTMLButtonElement>(
      '[data-testid="lifecycle-action-submit"]',
    );
    expect(submit, "primary action renders").toBeTruthy();
    submit!.click();
    flushSync();
    await settle(12);

    expect(runCardAction).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state"),
    ).toBe("blocked");
    expect(
      host.querySelector("[data-testid='lifecycle-card-reason']")?.textContent,
    ).toContain("Viewer cannot act on this card");
    expect(host.querySelector("[data-testid='channel-action-error']")).toBeNull();
  });

  it("Given a card action submitted twice quickly, when both reach the server, then the UI shows a single done state and no duplicate side effect", async () => {
    const keys: string[] = [];
    const runCardAction = vi.fn(async (args: { idempotencyKey?: string }) => {
      keys.push(args.idempotencyKey ?? "");
      return ok({
        cardId: "card_create_1",
        actionId: "submit",
        eventId: "evt_lifecycle",
        state: "pending",
        replayed: keys.length > 1,
      });
    });
    let envelope: typeof OPEN_CARD = { ...OPEN_CARD, state: "open" };
    const fetchChannel = vi.fn(
      async (_args?: { channelId?: string; since?: string | null }) =>
        ok({ messages: [cardMessage(envelope)], nextCursor: null }),
    );
    const wakes = await mountApp({ runCardAction, fetchChannel });

    const submit = host.querySelector<HTMLButtonElement>(
      '[data-testid="lifecycle-action-submit"]',
    );
    submit!.click();
    submit!.click();
    flushSync();
    await settle(12);

    expect(runCardAction).toHaveBeenCalledTimes(1);
    expect(
      host.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state"),
    ).toBe("pending");

    envelope = { ...OPEN_CARD, state: "done" };
    wakes.emit("channel:new-message", {
      channelId: "setup",
      eventId: "evt_lifecycle",
      createdAt: "2026-09-02T14:12:00.000Z",
    });
    await settle(12);

    expect(fetchChannel.mock.calls.length).toBeGreaterThan(1);
    const lastCall = fetchChannel.mock.calls.at(-1);
    const refetch = lastCall?.[0] ?? {};
    expect(refetch.channelId).toBe("setup");
    expect(refetch.since ?? null).toBeNull();
    expect(
      host.querySelector("[data-testid='lifecycle-card']")?.getAttribute("data-state"),
    ).toBe("done");
    expect(
      host.querySelectorAll("[data-testid='lifecycle-card']"),
    ).toHaveLength(1);
  });
});
