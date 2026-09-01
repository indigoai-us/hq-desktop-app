// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";

/**
 * The rail can only show older-day DM rows if the shell actually re-reads DM
 * history. The incremental catch-up carries a stored `since` cursor, so on a
 * machine that already has one it would only ever see NEW events — the very
 * reason older DMs were missing. The mount pass must therefore backfill:
 * fetch without `since`, and leave the cursor alone so unread deltas stay the
 * incremental path's job.
 */

interface InboxCall {
  since?: unknown;
  limit?: unknown;
}

function adapter(calls: InboxCall[]): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
    },
    notifications: {
      fetchDmInbox: async (opts?: Record<string, unknown>) => {
        calls.push({ since: opts?.since, limit: opts?.limit });
        return ok({
          events: [
            {
              fromPersonUid: "prs_jacob",
              fromDisplayName: "Jacob Posel",
              createdAt: "2026-08-30T18:00:00.000Z",
            },
          ],
        });
      },
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({
        ok: false as const,
        reason: "unavailable",
      }),
    },
  } as unknown as PlatformAdapter;
}

/** happy-dom runs without localStorage here — install a real in-memory one so
 *  the shell's tenant storage can actually hold a cursor. */
function installStorage(cursor?: string): Map<string, string> {
  const store = new Map<string, string>();
  const api = {
    // Any tenant-scoped variant of the cursor key reads as already set, so the
    // test does not depend on how the shell scopes its keys.
    getItem: (k: string) =>
      store.get(k) ?? (cursor && k.endsWith("dm-inbox-since") ? cursor : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: api,
    configurable: true,
    writable: true,
  });
  return store;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

describe("DesktopApp DM inbox backfill", () => {
  it("fetches without the stored since cursor on mount and leaves it intact", async () => {
    const stale = "2026-08-31T23:59:59.000Z";
    // The shell scopes its storage keys per tenant, so seed every variant that
    // ends with the cursor suffix by pre-filling on first read below.
    const store = installStorage(stale);
    const calls: InboxCall[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter: adapter(calls),
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
        // Tenant storage is a no-op without an account id, and an inert store
        // would make this test vacuous — it must really hold a cursor.
        tenantAccountId: "acct_test",
        wakes: createChatWakeBus(),
        coreFixtures: false,
      },
    });
    await settle();

    expect(calls.length, "the shell reads the DM inbox on mount").toBeGreaterThan(
      0,
    );
    expect(
      calls[0]?.since,
      "the mount pass backfills — no since cursor, so older DM history is seen",
    ).toBeUndefined();

    const written = [...store.keys()].filter((key) =>
      key.endsWith("dm-inbox-since"),
    );
    expect(
      written,
      "the backfill must not advance the incremental cursor",
    ).toEqual([]);
  });
});
