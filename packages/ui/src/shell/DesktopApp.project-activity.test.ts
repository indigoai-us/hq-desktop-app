// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const CHANNEL_ID = "chn_project_activity";
const COMPANY_UID = "cmp_project_activity";
const PROJECT_ID = "project_activity";
const AGENT_UID = "agt_project_activity";

const PROJECT_ROW = {
  id: `ch:${CHANNEL_ID}`,
  kind: "channel",
  title: "Project Activity",
  channelId: CHANNEL_ID,
  channelScope: "project",
  companyUid: COMPANY_UID,
  projectId: PROJECT_ID,
} as ConversationRow;

const THREAD = { threadId: "thread_project_activity", projectId: PROJECT_ID };
const ACTIVITY = {
  eventId: "evt_project_progress",
  eventKind: "progress",
  authorUid: AGENT_UID,
  createdAt: "2026-09-30T12:00:00.000Z",
  payload: { summary: "Finished the project deployment" },
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function adapter(
  listProjectThreads = vi.fn(async () => ok({ threads: [THREAD], nextCursor: null })),
  listThreadEvents = vi.fn(async () => ok({ events: [ACTIVITY] })),
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () =>
        ok({ members: [{ personUid: AGENT_UID, displayName: "Project Operator" }] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
    },
    notifications: { fetchDmInbox: async () => ok({ events: [] }) },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    identity: { hasFeature: async () => ok(false) },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    workMesh: { listProjectThreads, listThreadEvents },
  } as unknown as PlatformAdapter;
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

async function mountProject(adapterValue: PlatformAdapter, wakes = createChatWakeBus()): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapterValue,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test Owner", email: "test@example.com" },
      initialRow: PROJECT_ROW,
      wakes,
      coreFixtures: false,
    },
  });
  await settle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.body.innerHTML = "";
});

describe("DesktopApp project activity", () => {
  it("fetches project threads and renders their events in the channel timeline", async () => {
    const listProjectThreads = vi.fn(async () =>
      ok({ threads: [THREAD], nextCursor: null }),
    );
    const listThreadEvents = vi.fn(async () => ok({ events: [ACTIVITY] }));
    await mountProject(adapter(listProjectThreads, listThreadEvents));

    await vi.waitFor(() => {
      expect(listProjectThreads).toHaveBeenCalledWith(PROJECT_ID, COMPANY_UID, undefined);
      expect(listThreadEvents).toHaveBeenCalledWith(THREAD.threadId, COMPANY_UID);
      expect(host.textContent).toContain("Finished the project deployment");
    });
    expect(host.textContent).toContain("Project Operator");
    expect(host.textContent).not.toContain(AGENT_UID);
  });

  it("limits event requests to the per-channel thread cap", async () => {
    const threads = Array.from({ length: 30 }, (_, index) => ({
      threadId: `thread-${index}`,
      projectId: PROJECT_ID,
    }));
    const listProjectThreads = vi.fn(async () =>
      ok({ threads, nextCursor: null }),
    );
    const listThreadEvents = vi.fn(async () => ok({ events: [] }));
    await mountProject(adapter(listProjectThreads, listThreadEvents));

    await vi.waitFor(() => expect(listThreadEvents).toHaveBeenCalledTimes(25));
    expect(listProjectThreads).toHaveBeenCalledTimes(1);
  });

  it("reloads the selected project after matching thread wakes and mesh catch-up", async () => {
    const listProjectThreads = vi.fn(async () =>
      ok({ threads: [THREAD], nextCursor: null }),
    );
    const bus = createChatWakeBus();
    await mountProject(adapter(listProjectThreads), bus);
    await vi.waitFor(() => expect(listProjectThreads).toHaveBeenCalledTimes(1));

    bus.emit("work-mesh:thread", { companyUid: "cmp_other", threadId: THREAD.threadId });
    await settle();
    expect(listProjectThreads).toHaveBeenCalledTimes(1);

    bus.emit("work-mesh:thread", { companyUid: COMPANY_UID, threadId: THREAD.threadId });
    await vi.waitFor(() => expect(listProjectThreads).toHaveBeenCalledTimes(2));

    bus.emit("mesh:catchup", { reason: "focus" });
    await vi.waitFor(() => expect(listProjectThreads).toHaveBeenCalledTimes(3));
  });

  it("keeps the project empty state hidden while loading and labels an empty result as activity", async () => {
    const threads = deferred<Awaited<ReturnType<typeof ok>>>();
    const listProjectThreads = vi.fn(() => threads.promise);
    await mountProject(adapter(listProjectThreads));
    await vi.waitFor(() => expect(listProjectThreads).toHaveBeenCalledTimes(1));
    expect(host.textContent).not.toContain("No activity yet");

    threads.resolve(ok({ threads: [], nextCursor: null }));
    await vi.waitFor(() => expect(host.textContent).toContain("No activity yet"));
  });
});
