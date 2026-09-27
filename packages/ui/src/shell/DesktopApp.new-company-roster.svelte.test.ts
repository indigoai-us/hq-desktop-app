// @vitest-environment happy-dom

/**
 * A company created outside the app (the setup bot runs `hq company create`)
 * reaches the channel directory before the host's company roster, which only
 * reloaded on sync-runner events that can land many minutes later. Clicking
 * the new company's channel then showed "This destination is no longer
 * available." to its owner. The shell now re-reads the roster before calling
 * a company-scoped row unavailable, and asks for a fresh roster as soon as a
 * rail row names a company the roster lacks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type {
  ChannelDirectoryFeed,
  ChannelDirectoryRow,
} from "../chat/channel-directory-reconciler.js";
import type { ChatSidebarApi } from "../chat/chat-api.js";
import type { Workspace } from "../chat/workspaces.js";

installMemoryLocalStorage();

const ACCOUNT_ID = "prs_owner";
const SELF = { uid: ACCOUNT_ID, displayName: "Ada Lovelace", email: "ada@x.y" };
const NEW_UID = "cmp_enabledai";
const NEW_CHANNEL = "enabledai";

const PERSONAL = {
  slug: "personal",
  displayName: "Personal",
  kind: "personal",
  state: "synced",
  cloudUid: null,
} as unknown as Workspace;

const NEW_COMPANY = {
  slug: "enabledai",
  displayName: "EnabledAI",
  kind: "company",
  state: "cloud-only",
  cloudUid: NEW_UID,
  role: "owner",
  membershipStatus: "active",
} as unknown as Workspace;

const DIRECTORY_ROWS: ChannelDirectoryRow[] = [
  {
    channelId: NEW_CHANNEL,
    type: "project",
    scope: "company",
    companyUid: NEW_UID,
    name: NEW_CHANNEL,
    subtitle: "EnabledAI · company",
    lastActivityAt: new Date().toISOString(),
    unreadCount: 0,
    memberCount: 1,
  },
];

function sidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (): Promise<ChannelDirectoryFeed> => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "newcompanyrostercursor00000000000000",
      cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      rows: DIRECTORY_ROWS,
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
    logToFile: async () => {},
  } as unknown as ChatSidebarApi;
}

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    meetings: { listAccounts: async () => ok([]) },
    appShell: { notificationPermissionState: async () => ok("default") },
    settings: { getSettings: async () => ok({}) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  window.localStorage.clear();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Mount with a roster that lacks the new company. `serverRoster` is what the
 * host's fresh fetch returns; `onrefreshroster` applies it like WorkShell.
 */
async function mountShell(serverRoster: Workspace[], withRefresh = true) {
  const props = $state({
    adapter: adapter(),
    sidebarApi: sidebarApi(),
    notificationsApi: createEmptyNotificationsApi(),
    self: SELF,
    companies: [PERSONAL] as Workspace[],
    tenantAccountId: ACCOUNT_ID,
    coreFixtures: false,
    onrefreshroster: undefined as undefined | (() => Promise<unknown>),
  });
  // Like WorkShell: an identical roster is not re-assigned.
  const slugs = (list: Workspace[]) => list.map((c) => c.slug).join(",");
  const refresh = vi.fn(async () => {
    if (slugs(props.companies) !== slugs(serverRoster)) props.companies = serverRoster;
    return true;
  });
  if (withRefresh) props.onrefreshroster = refresh;
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, { target: host, props });
  await settle();
  return { props, refresh };
}

function clickNewCompanyRow(): void {
  const title = Array.from(
    host!.querySelectorAll<HTMLElement>(".chat-row-title"),
  ).find((el) => el.textContent?.trim().includes(NEW_CHANNEL));
  expect(title, "the new company's channel is in the rail").toBeTruthy();
  title!.closest("button")!.click();
}

const unavailable = () =>
  host!.querySelector('[data-testid="navigation-unavailable"]');

describe("a company created outside the app", () => {
  it("asks the host for a fresh roster as soon as its channel shows up", async () => {
    const { refresh } = await mountShell([PERSONAL, NEW_COMPANY]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("opens its channel instead of calling it unavailable", async () => {
    const { props, refresh } = await mountShell([PERSONAL, NEW_COMPANY]);
    // Simulate the click landing before the proactive refresh applied.
    props.companies = [PERSONAL];
    await settle();
    refresh.mockClear();
    clickNewCompanyRow();
    await settle(20);
    expect(refresh).toHaveBeenCalled();
    expect(unavailable()).toBeNull();
    expect(
      host!.querySelector('[data-testid="channel-header"]')?.textContent,
      "the new company's channel is open",
    ).toContain(NEW_CHANNEL);
  });

  it("still says unavailable when the fresh roster really lacks the company", async () => {
    const { refresh } = await mountShell([PERSONAL]);
    await settle(40);
    clickNewCompanyRow();
    await settle(20);
    expect(refresh).toHaveBeenCalled();
    expect(unavailable()).not.toBeNull();
  });

  it("without a refresh seam the old rule holds", async () => {
    await mountShell([PERSONAL], false);
    clickNewCompanyRow();
    await settle(20);
    expect(unavailable()).not.toBeNull();
  });
});
