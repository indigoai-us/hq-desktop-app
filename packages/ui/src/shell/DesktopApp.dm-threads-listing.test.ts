// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { InboxDmActivity } from "../chat/live-catchup.js";

/**
 * The inbox (GET /v1/notify/inbox) is a feed of messages RECEIVED and it is
 * capped. A pair where the owner sent last, or whose history fell out of the
 * window, has no row in it at all. The backfill pass therefore also reads the
 * per-user DM peer index (GET /v1/notify/dm-threads, hq-pro PR #2813) and
 * merges it — newest stamp per peer wins. Servers that predate the route
 * answer 404 and hosts may omit the method: both must fall back to inbox-only.
 */

const INBOX_JACOB_AT = "2026-09-01T21:38:07.837Z";
const THREADS_JACOB_AT = "2026-09-01T21:38:30.000Z";
const SENT_LAST_AT = "2026-08-27T09:00:00.000Z";

type ThreadsMode = "present" | "404" | "500" | "absent";

function adapter(mode: ThreadsMode, threadsCalls: unknown[]): PlatformAdapter {
  const notifications: Record<string, unknown> = {
    fetchDmInbox: async () =>
      ok({
        events: [
          {
            fromPersonUid: "prs_jacob",
            fromDisplayName: "Jacob Posel",
            createdAt: INBOX_JACOB_AT,
          },
        ],
      }),
  };
  if (mode !== "absent") {
    notifications.fetchDmThreads = async (opts?: Record<string, unknown>) => {
      threadsCalls.push(opts);
      if (mode === "404") return failure("http-404", "Not found");
      if (mode === "500") return failure("http-500", "boom");
      return ok({
        threads: [
          { peerUid: "prs_jacob", lastActivityAt: THREADS_JACOB_AT, lastEventId: "e2" },
          { peerUid: "prs_sent_last", lastActivityAt: SENT_LAST_AT, lastEventId: "e1" },
          { peerUid: "prs_me", lastActivityAt: THREADS_JACOB_AT, lastEventId: "e3" },
        ],
      });
    };
  }
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
    notifications,
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountWith(mode: ThreadsMode) {
  const wakes = createChatWakeBus();
  const activity: InboxDmActivity[][] = [];
  wakes.on("dm:pair-unreads", (payload) => {
    if (payload.activity) activity.push(payload.activity);
  });
  const threadsCalls: unknown[] = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(mode, threadsCalls),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      tenantAccountId: "acct_test",
      wakes,
      coreFixtures: false,
    },
  });
  await settle();
  const merged = new Map<string, string>();
  for (const batch of activity) {
    for (const entry of batch) {
      const prev = merged.get(entry.personUid);
      if (!prev || entry.lastMessageAt > prev)
        merged.set(entry.personUid, entry.lastMessageAt);
    }
  }
  return { merged, threadsCalls, activity };
}

describe("DesktopApp DM threads listing merge", () => {
  it("merges the peer index with the inbox: newest stamp wins and owner-sent-last pairs appear", async () => {
    const { merged, threadsCalls } = await mountWith("present");
    expect(threadsCalls.length, "the backfill reads dm-threads").toBeGreaterThan(0);
    expect(merged.get("prs_jacob")).toBe(THREADS_JACOB_AT);
    expect(
      merged.get("prs_sent_last"),
      "a pair with no inbox row still gets its stamp from the peer index",
    ).toBe(SENT_LAST_AT);
    expect(merged.has("prs_me"), "self is never a DM peer row").toBe(false);
  });

  it("falls back to inbox-only when the server answers 404 (route predates it)", async () => {
    const { merged, activity } = await mountWith("404");
    expect(activity.length).toBeGreaterThan(0);
    expect(merged.get("prs_jacob")).toBe(INBOX_JACOB_AT);
    expect(merged.has("prs_sent_last")).toBe(false);
  });

  it("falls back to inbox-only on other failures without dropping inbox stamps", async () => {
    const { merged } = await mountWith("500");
    expect(merged.get("prs_jacob")).toBe(INBOX_JACOB_AT);
    expect(merged.has("prs_sent_last")).toBe(false);
  });

  it("works on a host adapter that has no fetchDmThreads at all", async () => {
    const { merged, threadsCalls } = await mountWith("absent");
    expect(threadsCalls).toEqual([]);
    expect(merged.get("prs_jacob")).toBe(INBOX_JACOB_AT);
  });
});
