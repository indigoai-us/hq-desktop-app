// @vitest-environment happy-dom

/**
 * A person who set HQ up before the welcome channel existed ("I previously
 * ran setup for HQ, but when I opened the desktop view it showed me Run
 * Setup") must not be greeted with Run Setup. The host's setup status says
 * the guided run is not owed on this machine: boot goes to their channels,
 * and #welcome shows the finished state (the finale) instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID } from "../chat/setup-channel.js";
import type { SetupRunApi } from "../chat/setup-run.js";
import type { Workspace } from "../chat/workspaces.js";

const ACME: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const ACME_CHANNEL_ROW = {
  channelId: "chn_acme",
  type: "chat",
  scope: "company",
  companyUid: "cmp_acme",
  name: "acme",
  lastActivityAt: new Date().toISOString(),
};

function adapter(welcomeSetupOwed: boolean): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
  } as unknown as PlatformAdapter;
}

function setupRun(): SetupRunApi {
  return {
    preflight: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => "sess-42"),
    attach: vi.fn(async () => true),
    subscribe: vi.fn(() => () => {}),
    answerQuestion: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

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

// One mount per file: the sidebar's boot pick keeps module-level state across
// mounts, so a second mount here would never auto-open. The owed (new install)
// path is covered by ChatSidebar.auto-open-setup.test.ts and
// DesktopApp.setup-run.test.ts.
async function mountApp(welcomeSetupOwed: boolean) {
  const api = setupRun();
  const onselectrow = vi.fn();
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(welcomeSetupOwed),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
      companies: [ACME],
      seedDirectory: [ACME_CHANNEL_ROW],
      onselectrow,
      extraPages: {
        sessions: {
          label: "Sessions",
          detail: "Local sessions",
          component: ExtraPageProbe,
          createAction: { label: "New session", param: () => "new?draft=y" },
          setupAction: { label: "Run Setup", param: () => "new?draft=x&prompt=%2Fsetup" },
          setupRun: api,
        },
      },
    },
  });
  await settle();
  // The boot pick waits for the host's answer, then the directory: real time.
  for (let i = 0; i < 80 && onselectrow.mock.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 100));
  expect(onselectrow).toHaveBeenCalled();
  return { api, onselectrow };
}

describe("DesktopApp on a machine that finished setup before the welcome flow", () => {
  it("boots to the company channel, and #welcome shows the finished state instead of Run Setup", async () => {
    const { api, onselectrow } = await mountApp(false);
    expect(onselectrow.mock.calls.map(([row]) => (row as { id: string }).id)).not.toContain(SETUP_ROW_ID);
    host.querySelector<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`)!.click();
    await settle();
    expect(host.querySelector('[data-testid="setup-run"]')).toBeNull();
    const finish = host.querySelector('[data-testid="setup-agent-finish"]');
    expect(finish).toBeTruthy();
    expect(finish!.querySelector('[data-testid="setup-agent-open-sessions"]')?.textContent?.trim()).toBe("Continue in HQ Sessions");
    expect(finish!.querySelector('[data-testid="setup-run-again"]')).toBeTruthy();
    expect(api.start).not.toHaveBeenCalled();
  }, 15_000);
});
