// @vitest-environment happy-dom

/**
 * Regression: the shell's `conversationApi.runCardAction` wrapper used to
 * drop `agentChannelId` / `agentUid` from the adapter result, so a
 * create_agent accept never selected the freshly minted agent channel
 * (US-006/011). `submitLifecycleCardAction` is covered in card-action.test;
 * this pins the wrapper → handleCardAction → requestChannelOpen path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { OPEN_CHANNEL_EVENT, takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

/** The company channel where the create_agent sequence is posted. */
const COMPANY_ROW: ConversationRow = {
  id: "ch:chn_acme",
  kind: "channel",
  title: "acme",
  channelId: "chn_acme",
  channelScope: "company",
  companyUid: "cmp_acme",
} as ConversationRow;

const CREATE_AGENT_CARD = {
  v: 1,
  type: "lifecycle_card",
  cardId: "card_create_agent_3",
  kind: "create_agent",
  companyUid: "cmp_acme",
  state: "open",
  title: "Create an agent",
  fields: [
    {
      id: "size",
      label: "Size",
      control: "radio",
      value: "basic",
      options: [{ id: "basic", label: "Basic" }],
    },
  ],
  actions: [{ id: "create", label: "Create agent", style: "primary" }],
  viewer: { canAct: true },
};

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
      ...messaging,
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("DesktopApp create_agent accept", () => {
  it("selects the minted agent channel returned by run_card_action", async () => {
    const runCardAction = vi.fn(async () =>
      ok({
        cardId: "card_create_agent_3",
        actionId: "create",
        state: "done",
        replayed: false,
        agentChannelId: "chn_agent_polar",
        agentUid: "agt_polar",
      }),
    );
    const fetchChannel = vi.fn(async () =>
      ok({
        messages: [
          {
            eventId: "evt_create_agent",
            fromDisplayName: "HQ",
            body: "Create an agent",
            createdAt: "2026-09-04T12:00:00.000Z",
            direction: "in",
            messageKind: "system",
            systemEvent: CREATE_AGENT_CARD,
          },
        ],
        nextCursor: null,
      }),
    );
    const opened: string[] = [];
    const onOpen = (event: Event) => {
      opened.push(String((event as CustomEvent).detail?.channelId ?? ""));
    };
    window.addEventListener(OPEN_CHANNEL_EVENT, onOpen);

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter({ runCardAction, fetchChannel }),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan Johnson",
          email: "stefan@example.com",
        },
        coreFixtures: false,
        initialRow: COMPANY_ROW,
      },
    });
    // The shell defers the first timeline hydrate to a real timer, so wait on
    // the wall clock for the card rather than flushing microtasks.
    await vi.waitFor(
      () => {
        expect(
          host.querySelector('[data-testid="lifecycle-action-create"]'),
          "create_agent card renders its primary action",
        ).toBeTruthy();
      },
      { timeout: 15_000, interval: 50 },
    );
    host
      .querySelector<HTMLButtonElement>('[data-testid="lifecycle-action-create"]')!
      .click();
    await settle(12);

    window.removeEventListener(OPEN_CHANNEL_EVENT, onOpen);
    expect(runCardAction).toHaveBeenCalledTimes(1);
    expect(opened).toContain("chn_agent_polar");
  }, 30_000);
});
