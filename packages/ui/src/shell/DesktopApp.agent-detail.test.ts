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

const AGENT_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";
const AGENT_NAME = "Izzy";
const HUMAN_UID = "prs_marcus";
const HUMAN_NAME = "Marcus Chen";

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
    agents: {
      getStatus: async () =>
        ok({
          agent: {
            uid: AGENT_UID,
            name: AGENT_NAME,
            companyUid: "cmp_indigo",
            profile: { displayName: AGENT_NAME, description: "Fleet" },
            runtime: { status: "running" },
          },
          setupState: { phase: "ready" },
        }),
      listMobileRoster: async () => ok({ agents: [] }),
      listJobs: async () => ok({ jobs: [] }),
      pauseJob: async () => ok({}),
      updateProfile: async () => ok({}),
      stop: async () => ok({}),
      start: async () => ok({}),
      deprovision: async () => ok({}),
      listOwners: async () => ok({ owners: [] }),
      getCompanyTelemetry: async () => ok({ perMember: [] }),
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

async function mountOpen(personUid: string, displayName: string) {
  requestConversation({ personUid, email: "", displayName });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: {
        ...createFixtureChatSidebarApi(),
        listContacts: async () => ({
          contacts: [
            {
              personUid,
              email: "",
              displayName,
              lastMessageAt: new Date().toISOString(),
              lastActivityAt: new Date().toISOString(),
            },
          ],
        }),
      },
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan", email: "s@x.y" },
      coreFixtures: false,
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(
      host.querySelector('[data-testid="channel-name"]')?.textContent?.trim(),
    ).toBe(displayName);
  });
}

describe("DesktopApp agent detail pane", () => {
  it("opens the agent pane from the DM header for an agent", async () => {
    await mountOpen(AGENT_UID, AGENT_NAME);
    expect(host.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
    const opener = host.querySelector(
      '[data-testid="channel-header-agent"]',
    ) as HTMLButtonElement | null;
    expect(opener).not.toBeNull();
    opener!.click();
    await tick();
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="agent-detail-panel"]'),
      ).not.toBeNull();
    });
    expect(
      host.querySelector('[data-testid="agent-detail-name"]')?.textContent,
    ).toContain(AGENT_NAME);
    expect(host.querySelector('[data-testid="profile-column"]')).toBeNull();
  });

  it("does not open the agent pane from a human DM header", async () => {
    await mountOpen(HUMAN_UID, HUMAN_NAME);
    expect(host.querySelector('[data-testid="channel-header-agent"]')).toBeNull();
    (
      host.querySelector('[data-testid="channel-name"]') as HTMLElement
    ).click();
    await tick();
    expect(host.querySelector('[data-testid="agent-detail-panel"]')).toBeNull();
    expect(host.querySelector('[data-testid="member-profile-panel"]')).toBeNull();
  });
});
