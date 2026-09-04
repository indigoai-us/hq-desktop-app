// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  requestConversation,
  takePendingConversation,
} from "../chat/pending-conversation.js";
import type { ChatSidebarApi, ContactsResponse } from "../chat/chat-api.js";
import type { DmContactInput } from "../chat/sidebar-model.js";

const AGENT_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";
const AGENT_NAME = "Polar Data Agent";
const AGENT_ROW_ID = `dm:${AGENT_UID}`;

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
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

function deferredContactsApi(): {
  sidebarApi: ChatSidebarApi;
  resolveContacts: (contacts: DmContactInput[]) => void;
} {
  let resolveContacts!: (value: ContactsResponse) => void;
  const contactsPromise = new Promise<ContactsResponse>((resolve) => {
    resolveContacts = resolve;
  });
  const sidebarApi: ChatSidebarApi = {
    ...createFixtureChatSidebarApi(),
    listContacts: async () => contactsPromise,
  };
  return {
    sidebarApi,
    resolveContacts: (contacts) => resolveContacts({ contacts }),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingConversation();
});

afterEach(async () => {
  takePendingConversation();
  if (component) await unmount(component);
  component = null;
  host?.remove();
  window.localStorage?.clear?.();
});

describe("DesktopApp DM header name from widget open", () => {
  it("never paints a raw agent uid, then hydrates the rail display name", async () => {
    const { sidebarApi, resolveContacts } = deferredContactsApi();
    const recent = new Date().toISOString();

    requestConversation({
      personUid: AGENT_UID,
      email: "",
      displayName: "",
    });

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: webAdapter(),
        sidebarApi,
        notificationsApi: createEmptyNotificationsApi(),
        self: {
          uid: "prs_test",
          displayName: "Stefan",
          email: "s@x.y",
        },
        coreFixtures: false,
      },
    });

    await tick();

    const header = host.querySelector('[data-testid="channel-name"]');
    expect(header, "pending DM opens the conversation header").toBeTruthy();
    expect(header?.textContent ?? "").not.toContain("agt_");
    expect(header?.textContent ?? "").not.toContain(AGENT_UID);

    const composer =
      host.querySelector<HTMLTextAreaElement>(
        '[data-testid="conversation-composer"]',
      ) ?? host.querySelector("textarea");
    expect(composer, "composer renders for the pending DM").toBeTruthy();
    expect(composer?.placeholder ?? "").not.toContain("agt_");
    expect(composer?.placeholder ?? "").not.toContain(AGENT_UID);

    resolveContacts([
      {
        personUid: AGENT_UID,
        email: "",
        displayName: AGENT_NAME,
        lastMessageAt: recent,
        lastActivityAt: recent,
      },
    ]);

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="channel-name"]')?.textContent?.trim(),
      ).toBe(AGENT_NAME);
    });

    const hydratedComposer =
      host.querySelector<HTMLTextAreaElement>(
        '[data-testid="conversation-composer"]',
      ) ?? host.querySelector("textarea");
    expect(hydratedComposer?.placeholder).toBe(
      `Message ${AGENT_NAME} — or type @ to mention an agent…`,
    );

    const railTitle = host.querySelector(
      `[data-conversation-id="${AGENT_ROW_ID}"] .chat-row-title`,
    );
    expect(railTitle?.textContent?.trim()).toBe(AGENT_NAME);
    expect(railTitle?.textContent?.trim()).toBe(
      host.querySelector('[data-testid="channel-name"]')?.textContent?.trim(),
    );
  });
});
