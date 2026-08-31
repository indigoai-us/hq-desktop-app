// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";

function adapter(): PlatformAdapter {
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

describe("DesktopApp synthetic #setup channel", () => {
  it("pins #setup in the sidebar and routes selection to the setup intro", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(),
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
    await tick();
    await tick();

    const row = host.querySelector<HTMLButtonElement>(
      `[data-conversation-id="${SETUP_ROW_ID}"]`,
    );
    expect(row, "pinned #setup row renders in the sidebar rail").toBeTruthy();
    // Pinned section hosts the row (dedup + pin ride the derivation layer).
    expect(row?.closest('[aria-labelledby="chat-pinned-label"]')).toBeTruthy();

    row?.click();
    await tick();
    await tick();

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
});
