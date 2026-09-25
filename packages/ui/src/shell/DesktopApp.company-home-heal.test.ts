// @vitest-environment happy-dom

/**
 * Regression for the "Amass has no company chrome until restart" heal bug.
 *
 * A company whose roster row has no `homeChannelId` yet (a legacy/new
 * company still provisioning server-side) gets one lazily: clicking its
 * disabled Companies-row calls `ensureCompanyHomeChannel`, which creates the
 * channel and opens it. Before this fix the opened channel rendered with NO
 * company chrome (no hero/header/settings) because `DesktopApp`'s chrome
 * predicate is derived straight from the roster prop's `homeChannelId` map,
 * which the client never patched in-memory — only a full app restart (a
 * fresh roster fetch) picked the new id up.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type { ChannelDirectoryFeed } from "../chat/channel-directory-reconciler.js";
import type { ChatSidebarApi } from "../chat/chat-api.js";
import type { Workspace } from "../chat/workspaces.js";

const ACCOUNT_ID = "prs_owner";
const SELF = { uid: ACCOUNT_ID, displayName: "Ada Lovelace", email: "ada@x.y" };

const AMASS_UID = "cmp_amass";
const AMASS_SLUG = "amass";
const AMASS_HOME_CHANNEL = "chn_amass_home";

const COMPANIES: Workspace[] = [
  {
    slug: AMASS_SLUG,
    displayName: "Amass",
    kind: "company",
    state: "synced",
    cloudUid: AMASS_UID,
    role: "member",
    membershipStatus: "active",
    // No `homeChannelId` — the roster row hasn't been provisioned yet.
  } as Workspace,
];

installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (): Promise<ChannelDirectoryFeed> => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "companyhomehealcursor00000000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: [],
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
    // Idempotent server endpoint: creates (or adopts) the company's one
    // home channel and returns its id. Marked `isCompanyHome` + company
    // scope, same as the real server contract.
    ensureCompanyHomeChannel: async (companyUid: string) => {
      expect(companyUid).toBe(AMASS_UID);
      return { homeChannelId: AMASS_HOME_CHANNEL };
    },
  };
}

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async ({ channelId }: { channelId: string }) => {
        if (channelId === AMASS_HOME_CHANNEL) {
          return ok({
            channel: {
              channelId: AMASS_HOME_CHANNEL,
              name: AMASS_SLUG,
              scope: "company",
              companyUid: AMASS_UID,
              isCompanyHome: true,
            },
            messages: [],
            nextCursor: null,
          });
        }
        return ok({ messages: [], nextCursor: null });
      },
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    meetings: { listAccounts: async () => ok([]) },
    appShell: { notificationPermissionState: async () => ok("default") },
    settings: { getSettings: async () => ok({}) },
  } as unknown as PlatformAdapter;
}

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mountShell(): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: sidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: SELF,
      companies: COMPANIES,
      tenantAccountId: ACCOUNT_ID,
      coreFixtures: false,
    },
  });
  await settle();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
});

describe("company-home heal: chrome without a restart", () => {
  beforeEach(mountShell);

  it("shows company chrome immediately after ensureCompanyHomeChannel resolves a missing homeChannelId", async () => {
    const disabledRow = host.querySelector<HTMLButtonElement>(
      `[data-testid="chat-companies-row-disabled-${AMASS_UID}"]`,
    );
    expect(disabledRow, "Amass companies-row (disabled, no homeChannelId yet)").toBeTruthy();

    disabledRow!.click();
    await settle();

    // The channel opened and is selected.
    expect(host.querySelector('[data-testid="company-hero"]')).toBeTruthy();
    expect(host.innerHTML).toContain("Amass");

    // The Companies row itself flips from disabled to the normal, enabled
    // row — reading `homeChannelId` back off the (now-patched) roster —
    // without any remount/restart.
    const enabledRow = host.querySelector<HTMLButtonElement>(
      `[data-testid="chat-companies-row-${AMASS_UID}"]`,
    );
    expect(enabledRow, "Amass companies-row flips to enabled in place").toBeTruthy();
    expect(
      host.querySelector(`[data-testid="chat-companies-row-disabled-${AMASS_UID}"]`),
    ).toBeFalsy();
  });
});
