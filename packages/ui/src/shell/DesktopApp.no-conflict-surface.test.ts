// @vitest-environment happy-dom

/**
 * No conflict surface, mounted inside the real shell.
 *
 * Owner decision 2026-10-13: hq-cloud parks the losing copy of a conflicted
 * file under `.hq/conflict-backups/` and keeps the cloud copy live, and the
 * desktop app says nothing about it. This test delivers a conflict both ways
 * the runner reports one (the journal count behind get_sync_status, and a
 * per-file `sync:conflict` event) and proves no card, badge, toast, dot or
 * resolve action appears anywhere in the shell or the Core popover.
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

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };
const CONFLICT_PATH = "companies/acme/knowledge/pricing.md";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let openInEditor: ReturnType<typeof vi.fn>;

function buildAdapter(): PlatformAdapter {
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
      getSyncStatus: async () =>
        ok({
          lastSyncAt: "2026-10-13T00:00:00Z",
          pendingFiles: 3,
          conflicts: 3,
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

/** Deliver a conflict the way the runner does and open the Core popover. */
async function deliverConflictAndOpenCore(
  events: ReturnType<typeof createSyncEventHost>,
): Promise<void> {
  events.emit("sync:conflict", { path: CONFLICT_PATH, canAutoResolve: false });
  events.emit("sync:complete", {
    company: "acme",
    filesChanged: 0,
    conflicts: 1,
    aborted: false,
  });
  await settle();
  host
    .querySelector<HTMLButtonElement>('[data-testid="titlebar-core-pill"]')!
    .click();
  await settle();
}

const CONFLICT_WORDING =
  /conflict|changed in two places|needs a decision|need you|keep local|keep cloud|take theirs|keep mine/i;

describe("DesktopApp has no conflict surface", () => {
  it("renders no conflict card, row or resolve action in the Core popover", async () => {
    const events = await mountShell(buildAdapter());
    await deliverConflictAndOpenCore(events);

    expect(
      host.querySelector('[data-testid="titlebar-core-pill"]'),
      "the Core pill still renders, so the popover was really opened",
    ).toBeTruthy();
    for (const testid of [
      "core-popover-rescue-card",
      "core-popover-conflict-header",
      "core-popover-conflict-row",
      "core-popover-resolve-conflicts",
      "core-popover-keep-local",
      "core-popover-keep-cloud",
      "core-popover-open-editor",
    ]) {
      expect(host.querySelector(`[data-testid="${testid}"]`), testid).toBeNull();
    }
  });

  it("keeps the Core dot calm while conflicts are parked", async () => {
    const events = await mountShell(buildAdapter());
    await deliverConflictAndOpenCore(events);

    const dot = host.querySelector('[data-testid="titlebar-core-dot"]');
    expect(dot?.getAttribute("data-tone")).not.toBe("warn");
  });

  it("says nothing about conflicts anywhere in the window", async () => {
    const events = await mountShell(buildAdapter());
    await deliverConflictAndOpenCore(events);

    expect(document.body.textContent ?? "").not.toMatch(CONFLICT_WORDING);
    for (const el of Array.from(document.body.querySelectorAll("[title],[aria-label]"))) {
      expect(el.getAttribute("title") ?? "").not.toMatch(CONFLICT_WORDING);
      expect(el.getAttribute("aria-label") ?? "").not.toMatch(CONFLICT_WORDING);
    }
    expect(openInEditor).not.toHaveBeenCalled();
  });
});
