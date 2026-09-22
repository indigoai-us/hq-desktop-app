// @vitest-environment happy-dom

/**
 * The Core popover's per-file conflict controls, mounted inside the real
 * shell.
 *
 * DesktopApp never passed `onresolveconflict` / `onopenconflict` down to
 * V4TitleBar, so Keep local / Keep cloud / Open in editor rendered and did
 * nothing in the desktop window. The menubar popover used to be the fallback
 * path; it is going away. This test mounts the shell, delivers a conflict, and
 * proves the click reaches the platform adapter with the right file and
 * strategy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, failure, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };
const CONFLICT_PATH = "companies/acme/knowledge/pricing.md";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let resolveConflict: ReturnType<typeof vi.fn>;
let openInEditor: ReturnType<typeof vi.fn>;

function buildAdapter(
  resolver: (
    path: string,
    strategy: string,
  ) => Promise<unknown> = async () => ok(undefined),
): PlatformAdapter {
  resolveConflict = vi.fn(resolver);
  openInEditor = vi.fn(async () => ok(undefined));
  return {
    kind: "desktop",
    isAvailable: (cap: string) => cap === "canSync" || cap === "canLaunchApps",
    capabilities: { canSync: true, canLaunchApps: true },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    sync: {
      startSync: async () => ok(undefined),
      resolveConflict,
      getSyncStatus: async () =>
        ok({
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 1,
          daemonRunning: true,
          source: "journal",
          hqFolderPath: "/tmp/hq",
        }),
    },
    shell: { openInEditor },
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

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

type Listener = (event: { payload?: unknown }) => void;

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

async function mountShell(adapter: PlatformAdapter) {
  const events = createSyncEventHost();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies: [],
      syncEvents: events.host,
      coreFixtures: false,
    },
  });
  await settle();
  return events;
}

/** Deliver a conflict and open the Core popover it lists in. */
async function openConflictRow(
  events: ReturnType<typeof createSyncEventHost>,
  path = CONFLICT_PATH,
): Promise<void> {
  events.emit("sync:conflict", { path, canAutoResolve: false });
  await settle();
  host
    .querySelector<HTMLButtonElement>('[data-testid="titlebar-core-pill"]')!
    .click();
  await settle();
}

describe("DesktopApp conflict resolution", () => {
  it("routes Keep local to resolve_conflict for the row's file", async () => {
    const events = await mountShell(buildAdapter());
    await openConflictRow(events);

    const row = host.querySelector('[data-testid="core-popover-conflict-row"]');
    expect(row, "the conflict row renders in the Core popover").toBeTruthy();
    expect(
      row?.querySelector('[data-testid="conflict-row-path"]')?.getAttribute("title"),
    ).toBe(CONFLICT_PATH);

    host
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-keep-local"]')!
      .click();
    await settle();

    expect(resolveConflict).toHaveBeenCalledTimes(1);
    expect(resolveConflict).toHaveBeenCalledWith(CONFLICT_PATH, "keep-local");
  });

  it("routes Keep cloud to the keep-remote strategy", async () => {
    const events = await mountShell(buildAdapter());
    await openConflictRow(events);

    host
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-keep-cloud"]')!
      .click();
    await settle();

    expect(resolveConflict).toHaveBeenCalledWith(CONFLICT_PATH, "keep-remote");
  });

  it("drops the resolved row so the popover stops offering it", async () => {
    const events = await mountShell(buildAdapter());
    await openConflictRow(events);

    host
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-keep-local"]')!
      .click();
    await settle();

    expect(
      host.querySelector('[data-testid="core-popover-conflict-row"]'),
      "a resolved file is no longer a conflict",
    ).toBeNull();
  });

  it("keeps the row and says so when the command fails", async () => {
    // A failed resolve that silently removed the row would tell the user the
    // file was handled when it was not.
    const events = await mountShell(
      buildAdapter(async () => failure("resolve-failed", "hq sync resolve exited 1")),
    );
    await openConflictRow(events);

    host
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-keep-local"]')!
      .click();
    await settle();

    const row = host.querySelector('[data-testid="core-popover-conflict-row"]');
    expect(row, "the unresolved file stays on the list").toBeTruthy();
    expect(row?.textContent).toContain("hq sync resolve exited 1");
  });

  it("routes Open in editor to open_in_editor", async () => {
    const events = await mountShell(buildAdapter());
    await openConflictRow(events);

    host
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-open-editor"]')!
      .click();
    await settle();

    expect(openInEditor).toHaveBeenCalledWith(CONFLICT_PATH);
  });
});
