// @vitest-environment happy-dom

/**
 * Company channel hero shows the company's display name ("Acme"), not the
 * channel slug — while the channel header itself keeps the slug.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };

const acmeWorkspace: Workspace = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: "hq-acme",
  hasLocalFolder: true,
  localPath: "/tmp/acme",
  membershipStatus: "active",
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
} as Workspace;

const adapter = {
  kind: "web",
  isAvailable: () => false,
  capabilities: {},
  messaging: {
    listContacts: async () => ok({ contacts: [] }),
    fetchChannel: async () => ok({ messages: [], nextCursor: null }),
    fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
    listChannelMembers: async () => ok({ members: [] }),
  },
} as unknown as PlatformAdapter;

const companyRow: ConversationRow = {
  id: "ch:chn_acme",
  kind: "channel",
  title: "acme",
  companyUid: "cmp_acme",
  unreadDot: false,
  lastActivityAt: Date.parse("2026-08-23T00:00:00.000Z"),
  pinned: false,
  channelId: "chn_acme",
  channelScope: "company",
  memberCount: 2,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

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
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      initialRow: companyRow,
      searchRows: [companyRow],
      wakes: createChatWakeBus(),
      self: SELF,
      companies,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp company hero title", () => {
  it("uses the company display name while the header keeps the slug", async () => {
    await mountApp([acmeWorkspace]);
    expect(host.querySelector('[data-testid="channel-name"]')?.textContent).toBe("acme");
    const hero = host.querySelector('[data-testid="company-hero"]');
    expect(hero, "company hero renders for a company channel").toBeTruthy();
    expect(hero?.querySelector(".company-hero-title")?.textContent?.trim()).toBe("Acme");
  });

  it("falls back to the channel name when no company name is known", async () => {
    await mountApp(null);
    const hero = host.querySelector('[data-testid="company-hero"]');
    expect(hero).toBeTruthy();
    expect(hero?.querySelector(".company-hero-title")?.textContent?.trim()).toBe("acme");
  });
});
