// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_CHANNEL_ID, SETUP_ROW_ID } from "../chat/setup-channel.js";

function adapter(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
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
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  messaging: Partial<PlatformAdapter["messaging"]> = {},
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(messaging),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
    },
  });
  await settle();
}

async function selectSetupRow(): Promise<HTMLButtonElement> {
  const row = host.querySelector<HTMLButtonElement>(
    `[data-conversation-id="${SETUP_ROW_ID}"]`,
  );
  expect(row, "pinned #setup row renders in the sidebar rail").toBeTruthy();
  row!.click();
  await settle();
  return row!;
}

describe("DesktopApp synthetic #setup channel", () => {
  it("pins #setup in the sidebar and routes selection to the setup intro", async () => {
    await mountApp();

    const row = await selectSetupRow();
    // Pinned section hosts the row (dedup + pin ride the derivation layer).
    expect(row.closest('[aria-labelledby="chat-pinned-label"]')).toBeTruthy();

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro, "setup intro renders in the conversation area").toBeTruthy();
    expect(intro?.textContent).toContain("What HQ Desktop is");
    expect(
      host.querySelector('[data-testid="setup-launch-claude"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-launch-codex"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="setup-launch-grok"]'),
    ).toBeTruthy();
    // The standard composer pipeline still hosts the thread below the intro.
    expect(host.querySelector('[data-testid="chat-stage"]')).toBeTruthy();
  });

  it("renders the setup intro inside the conversation scroller", async () => {
    await mountApp();
    await selectSetupRow();

    const intro = host.querySelector('[data-testid="setup-channel-intro"]');
    expect(intro, "setup intro renders").toBeTruthy();
    expect(
      intro?.closest(".dm-thread"),
      "intro lives inside the .dm-thread scroller so it scrolls with history",
    ).toBeTruthy();
  });

  it("sends from #setup through sendChannelMessage without a linked-channel error", async () => {
    const sendChannelMessage = vi.fn(
      async (_channelId: string, _body: string, _extras?: unknown) =>
        ok({ eventId: "evt_1", createdAt: new Date().toISOString() }),
    );
    await mountApp({ sendChannelMessage });
    await selectSetupRow();

    const composer = host.querySelector<HTMLTextAreaElement>(
      '[data-testid="conversation-composer"]',
    );
    const sendBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="composer-send"]',
    );
    expect(composer, "setup channel hosts the standard composer").toBeTruthy();
    expect(sendBtn, "send control renders").toBeTruthy();

    composer!.value = "need a hand with setup";
    composer!.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    sendBtn!.click();
    await settle(10);

    expect(sendChannelMessage).toHaveBeenCalledWith(
      SETUP_CHANNEL_ID,
      "need a hand with setup",
      expect.anything(),
    );
    expect(host.textContent).not.toMatch(/isn't linked yet/);
    expect(host.querySelector(".composer-attach-error")).toBeNull();
  });
});
