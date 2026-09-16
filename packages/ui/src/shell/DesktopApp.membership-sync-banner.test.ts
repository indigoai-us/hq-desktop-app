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
      syncEvents,
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

  it("scopes the sync to the company it names", async () => {
    // An unscoped start_sync is SyncRunScope::All — every workspace on the
    // machine — which is not what "pull it onto this machine" promises.
    await mountApp([joinableCompany]);
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
      .click();
    await settle();
    expect(startSync).toHaveBeenCalledWith("acme");
  });

  it("surfaces the reauth path, which start_sync reports as success", async () => {
    // commands/sync.rs returns Ok on the needs-reauth path deliberately and
    // emits sync:auth-error instead. Reading only the command result leaves
    // the user clicking Sync forever with no feedback and no membership.
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
      .click();
    await settle();

    events.emit("sync:auth-error", {
      message: "Your HQ session needs a quick refresh.",
    });
    await settle();

    expect(
      host.querySelector('[data-testid="membership-sync-error"]')?.textContent,
    ).toContain("needs a quick refresh");
    expect(
      host.querySelector<HTMLButtonElement>(
        '[data-testid="membership-sync-now"]',
      )!.disabled,
      "the control is released so the user can retry",
    ).toBe(false);
  });

  it("keeps the busy state until the sync actually completes", async () => {
    // start_sync resolves once the runner is REGISTERED, not when the pull
    // finishes, so clearing on the command result flickers Syncing… off while
    // the sync is still running.
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    const button = () =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="membership-sync-now"]',
      )!;

    button().click();
    await settle();
    expect(button().disabled, "still syncing after dispatch returns").toBe(true);
    expect(button().textContent?.trim()).toBe("Syncing…");

    // Another workspace's background run must not clear this banner.
    events.emit("sync:complete", { company: "someone-else" });
    await settle();
    expect(
      button().disabled,
      "a different company's sync:complete is not our completion",
    ).toBe(true);

    events.emit("sync:complete", { company: "acme" });
    await settle();
    expect(button().disabled).toBe(false);
  });

  it("ignores per-file sync:error, which is not a terminal failure", async () => {
    // SyncErrorEvent is emitted per file and the run continues past it.
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    const button = () =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="membership-sync-now"]',
      )!;
    button().click();
    await settle();

    events.emit("sync:error", {
      company: "acme",
      path: "docs/x.md",
      message: "Access denied",
    });
    await settle();
    expect(
      host.querySelector('[data-testid="membership-sync-error"]'),
      "one unreadable file is not a failed pull",
    ).toBeNull();
    expect(button().disabled, "still syncing").toBe(true);
  });

  it("ends the pull when the run finishes without a per-company complete", async () => {
    const events = createSyncEventHost();
    await mountApp([joinableCompany], events.host);
    const button = () =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="membership-sync-now"]',
      )!;
    button().click();
    await settle();

    events.emit("sync:all-complete", {
      companiesAttempted: 1,
      errors: [{ company: "acme", message: "Bucket is not reachable" }],
    });
    await settle();
    expect(button().disabled).toBe(false);
    expect(
      host.querySelector('[data-testid="membership-sync-error"]')?.textContent,
    ).toContain("Bucket is not reachable");
  });

  it("reports a dispatch failure instead of logging it and moving on", async () => {
    await mountApp([joinableCompany]);
    // buildAdapter() re-creates the spy during mount, so the override has to
    // be installed after mounting, not before.
    startSync.mockResolvedValueOnce({
      ok: false,
      reason: "runner-failed",
      message: "Sync is already running",
    });
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
      .click();
    await settle();

    expect(
      host.querySelector('[data-testid="membership-sync-error"]')?.textContent,
    ).toContain("Sync is already running");
  });

  it("releases the control when the platform has no event bus", async () => {
    // Web has no sync events; a spinner that can never resolve is worse than
    // no feedback at all.
    await mountApp([joinableCompany], null);
    const button = () =>
      host.querySelector<HTMLButtonElement>(
        '[data-testid="membership-sync-now"]',
      )!;
    button().click();
    await settle();
    expect(button().disabled).toBe(false);
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

  it("one Dismiss clears every pending membership", async () => {
    const second = workspace({
      slug: "initech",
      displayName: "Initech",
      state: "cloud-only",
      membershipStatus: "active",
      cloudUid: "cmp_initech",
      bucketName: "hq-initech",
    });
    await mountApp([joinableCompany, second]);
    expect(
      host.querySelector('[data-testid="membership-sync-banner"]')?.textContent,
    ).toContain("Added to Acme + 1 more");

    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-dismiss"]')!
      .click();
    await settle();

    expect(
      host.querySelector('[data-testid="membership-sync-banner"]'),
      "dismissing an aggregate banner must not re-render it for the next company",
    ).toBeNull();
  });

  it("renders no banner when there is nothing joinable", async () => {
    await mountApp([personalRow, pendingCompany]);
    expect(
      host.querySelector('[data-testid="membership-sync-banner"]'),
    ).toBeNull();
  });
});
