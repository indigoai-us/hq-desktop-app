// @vitest-environment happy-dom

/**
 * A company the person was just added to syncs onto this Mac by itself
 * (onboarding test, 2026-09-27: the setup bot created a company and the
 * person was then asked to press Sync to get it). The "Added to {company}"
 * banner now appears only when that automatic pull fails, and its Sync now is
 * the retry. Personal-vault and pending-invite rows are never pulled.
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

function buildAdapter(emailVerificationRequired?: boolean): PlatformAdapter {
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
      ...(emailVerificationRequired === undefined
        ? {}
        : {
            listSyncableWorkspaces: async () =>
              ok({ emailVerificationRequired }),
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

type Listener = (event: { payload?: unknown }) => void;

/**
 * Minimal stand-in for the host's app-level event bus. `emit` lets a test
 * deliver the outcome events the `start_sync` command result cannot carry.
 */
function createSyncEventHost() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    host: {
      listen: async (event: string, handler: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
    },
    emit(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
  };
}

async function mountApp(
  companies: Workspace[] | null,
  syncEvents: { listen: (e: string, h: Listener) => Promise<() => void> } | null = null,
  emailVerificationRequired?: boolean,
): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: buildAdapter(emailVerificationRequired),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies,
      syncEvents,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp membership sync", () => {
  const failDispatch = () =>
    startSync.mockResolvedValueOnce({ ok: false, reason: "runner-failed", message: "Sync is already running" });
  const banner = () => host.querySelector('[data-testid="membership-sync-banner"]');
  const syncNow = () => host.querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!;
  const errorText = () => host.querySelector('[data-testid="membership-sync-error"]')?.textContent ?? "";

  it("pulls a company you were just added to by itself, scoped to it, with no banner", async () => {
    await mountApp([joinableCompany, personalRow, pendingCompany]);
    expect(startSync).toHaveBeenCalledTimes(1);
    // Unscoped would be SyncRunScope::All, every workspace on the machine.
    expect(startSync).toHaveBeenCalledWith("acme");
    expect(banner(), "nobody is asked to press Sync").toBeNull();
  });

  it("never pulls personal-vault or pending-invite rows", async () => {
    await mountApp([personalRow, pendingCompany]);
    expect(startSync).not.toHaveBeenCalled();
    expect(banner()).toBeNull();
  });

  it("pulls each new company once, one after another", async () => {
    const second = workspace({
      slug: "initech",
      displayName: "Initech",
      cloudUid: "cmp_initech",
      bucketName: "hq-initech",
    });
    const events = createSyncEventHost();
    await mountApp([joinableCompany, second], events.host);
    expect(startSync).toHaveBeenCalledTimes(1);
    events.emit("sync:complete", { company: "acme" });
    await settle();
    expect(startSync).toHaveBeenCalledTimes(2);
    expect(startSync).toHaveBeenLastCalledWith("initech");
    events.emit("sync:complete", { company: "initech" });
    await settle();
    expect(startSync, "a finished pull is not repeated").toHaveBeenCalledTimes(2);
  });

  it("shows the banner when the automatic pull fails, and Sync now retries", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    // The first pull already ran; fail it through the run outcome instead.
    events.emit("sync:all-complete", {
      companiesAttempted: 1,
      errors: [{ company: "acme", message: "Bucket is not reachable" }],
    });
    await settle();
    expect(banner()?.textContent).toContain("Added to Acme");
    expect(errorText()).toContain("Bucket is not reachable");
    syncNow().click();
    await settle();
    expect(startSync).toHaveBeenCalledTimes(2);
    expect(startSync).toHaveBeenLastCalledWith("acme");
  });

  it("reports a dispatch failure on the retry instead of logging it and moving on", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    events.emit("sync:auth-error", { message: "Your HQ session needs a quick refresh." });
    await settle();
    failDispatch();
    syncNow().click();
    await settle();
    expect(errorText()).toContain("Sync is already running");
  });

  it("surfaces the reauth path, which start_sync reports as success", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    events.emit("sync:auth-error", { message: "Your HQ session needs a quick refresh." });
    await settle();
    expect(errorText()).toContain("needs a quick refresh");
    expect(syncNow().disabled, "the control is released so the user can retry").toBe(false);
  });

  it("a retry puts the banner away while it runs, and brings it back only if it fails again", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    events.emit("sync:auth-error", { message: "Your HQ session needs a quick refresh." });
    await settle();
    syncNow().click();
    await settle();
    expect(banner(), "the retry runs quietly, like the first pull").toBeNull();
    // Another workspace's run finishing is not this pull's outcome.
    events.emit("sync:complete", { company: "someone-else" });
    await settle();
    expect(banner()).toBeNull();
    events.emit("sync:auth-error", { message: "Still needs a refresh." });
    await settle();
    expect(errorText()).toContain("Still needs a refresh");
  });

  it("ignores per-file sync:error, which is not a terminal failure", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    events.emit("sync:error", { company: "acme", path: "docs/x.md", message: "Access denied" });
    await settle();
    expect(banner(), "one unreadable file is not a failed pull").toBeNull();
  });

  it("does not loop when the platform has no event bus", async () => {
    await mountApp([joinableCompany], null);
    await settle(12);
    expect(startSync).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });

  it("a failed pull's banner can be dismissed for the session", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    events.emit("sync:auth-error", { message: "Your HQ session needs a quick refresh." });
    await settle();
    expect(banner()).toBeTruthy();
    host.querySelector<HTMLButtonElement>('[data-testid="membership-sync-dismiss"]')!.click();
    await settle();
    expect(banner()).toBeNull();
  });

  it("shows an email-verification notice when pending invites are skipped", async () => {
    await mountApp([], null, true);
    const notice = host.querySelector('[data-testid="email-verification-notice"]');
    expect(notice?.textContent?.trim()).toBe("Verify your email to see pending company invites.");
    expect(host.querySelector('[data-testid="membership-sync-now"]')).toBeNull();
  });
});
