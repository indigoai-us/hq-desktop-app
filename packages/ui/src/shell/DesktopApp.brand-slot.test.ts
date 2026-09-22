// @vitest-environment happy-dom

/**
 * PL-04 wiring proof: the shell resolves the white-label brand from the same
 * membership enrichment the popover reads (`Workspace.brand` +
 * `brandingEnabled`) and paints it in its own header — so the slot has a live
 * consumer in the desktop window, not just a component test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { BRAND_CACHE_KEY } from "../brand/brand.js";
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
    state: "synced",
    cloudUid: "cmp_acme",
    bucketName: "hq-acme",
    hasLocalFolder: true,
    localPath: "/tmp/hq/companies/acme",
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  } as Workspace;
}

const entitled = workspace({
  brandingEnabled: true,
  brand: { logoUrlLight: "https://cdn.example.com/acme-light.png" },
});

const unentitled = workspace({
  slug: "globex",
  displayName: "Globex",
  cloudUid: "cmp_globex",
  brand: { logoUrlLight: "https://cdn.example.com/globex-light.png" },
});

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function buildAdapter(): PlatformAdapter {
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
      startSync: vi.fn(async () => ok(undefined)),
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

async function mountApp(
  companies: Workspace[] | null,
  rosterStatus: "loading" | "ready" | "failed" = "ready",
): Promise<void> {
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
      rosterStatus,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp white-label header slot", () => {
  it("paints the tenant logo for an entitled company", async () => {
    await mountApp([entitled]);
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeTruthy();
    expect(
      host
        .querySelector<HTMLImageElement>('[data-testid="brand-tenant-logo"]')
        ?.getAttribute("alt"),
    ).toBe("Acme");
  });

  it("leaves the chrome alone for a company without the entitlement", async () => {
    await mountApp([unentitled]);
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="titlebar-wordmark"]')?.textContent,
    ).toBe("HQ");
  });

  it("keeps painting the cached brand while the roster is unavailable", async () => {
    // The offline launch the brand cache exists for: a roster that has not
    // arrived is not evidence the entitlement was withdrawn.
    window.localStorage.setItem(
      BRAND_CACHE_KEY,
      JSON.stringify({
        brandingEnabled: true,
        brand: { logoUrlLight: "https://cdn.example.com/acme-light.png" },
        companySlug: "acme",
        cachedAt: new Date().toISOString(),
      }),
    );
    await mountApp(null, "loading");
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeTruthy();
  });

  it("drops the brand once the cloud says the entitlement is gone", async () => {
    window.localStorage.setItem(
      BRAND_CACHE_KEY,
      JSON.stringify({
        brandingEnabled: true,
        brand: { logoUrlLight: "https://cdn.example.com/acme-light.png" },
        companySlug: "acme",
        cachedAt: new Date().toISOString(),
      }),
    );
    await mountApp([unentitled]);
    expect(host.querySelector('[data-testid="titlebar-brand-slot"]')).toBeNull();
    expect(window.localStorage.getItem(BRAND_CACHE_KEY)).toBeNull();
  });
});
