// @vitest-environment happy-dom

/**
 * The desktop window's own version of the menubar popover's "You've been
 * added to {company} — Sync to pull it" notice. Proves the shared
 * `joinableMemberships()` selector (../chat/workspaces.js) is wired to a
 * genuinely mounted consumer inside the live shell, not orphaned — and that
 * personal-vault / pending-invite rows stay excluded end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { Workspace } from "../chat/workspaces.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "cloud-only",
    cloudUid: "cmp_acme",
    bucketName: "hq-acme",
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  } as Workspace;
}

const joinableCompany = workspace({
  slug: "acme",
  displayName: "Acme",
  state: "cloud-only",
  membershipStatus: "active",
});

// Phantom personal cloud-only row — never a "you've been added" target.
const personalRow = workspace({
  slug: "personal",
  displayName: "Personal",
  kind: "personal",
  state: "cloud-only",
  membershipStatus: "active",
  cloudUid: "cmp_personal",
  bucketName: "hq-personal",
});

// Unaccepted invite — nothing to pull yet.
const pendingCompany = workspace({
  slug: "globex",
  displayName: "Globex",
  state: "cloud-only",
  membershipStatus: "pending",
  cloudUid: "cmp_globex",
  bucketName: "hq-globex",
});

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let startSync: ReturnType<typeof vi.fn>;

function buildAdapter(): PlatformAdapter {
  startSync = vi.fn(async () => ok(undefined));
  return {
    kind: "desktop",
    isAvailable: (cap: string) => cap === "canSync",
    capabilities: { canSync: true },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    sync: {
      startSync,
      getSyncStatus: async () =>
        ok({
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: true,
          source: "journal",
          hqFolderPath: "/tmp/hq",
        }),
    },
  } as unknown as PlatformAdapter;
}

function resetSharedState(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
}

beforeEach(resetSharedState);
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetSharedState();
});

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(companies: Workspace[] | null): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: buildAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp membership sync banner", () => {
  it("shows the joinable membership and excludes personal + pending rows", async () => {
    await mountApp([joinableCompany, personalRow, pendingCompany]);
    const banner = host.querySelector('[data-testid="membership-sync-banner"]');
    expect(banner, "banner renders for a joinable membership").toBeTruthy();
    expect(banner?.textContent).toContain("Added to Acme");
    expect(banner?.textContent).not.toContain("Personal");
    expect(banner?.textContent).not.toContain("Globex");
  });

  it("starts a real sync through the platform adapter when acted on", async () => {
    await mountApp([joinableCompany]);
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
      .click();
    await settle();
    expect(startSync).toHaveBeenCalledTimes(1);
  });

  it("dismisses for the session without touching the popover's own state", async () => {
    await mountApp([joinableCompany]);
    expect(
      host.querySelector('[data-testid="membership-sync-banner"]'),
    ).toBeTruthy();
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-dismiss"]')!
      .click();
    await settle();
    expect(
      host.querySelector('[data-testid="membership-sync-banner"]'),
    ).toBeNull();
  });

  it("renders no banner when there is nothing joinable", async () => {
    await mountApp([personalRow, pendingCompany]);
    expect(
      host.querySelector('[data-testid="membership-sync-banner"]'),
    ).toBeNull();
  });
});
