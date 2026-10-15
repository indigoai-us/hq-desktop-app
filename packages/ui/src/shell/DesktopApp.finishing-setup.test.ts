// @vitest-environment happy-dom

/**
 * install-flow-rethink US-005b: DesktopApp mounts the Finishing setup chip
 * over the titlebar from its `installQueue` host. The chip shows while the
 * background queue is running and renders nothing while it is idle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import type { InstallQueueHost } from "./finishing-setup.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { LOCAL_BOTS_POLL_MS } from "../chat/local-bots.js";

const ASSISTANT_UID = "agt_assistant";

function webAdapter(extras: { sendDm?: ReturnType<typeof vi.fn>; assistantHere?: boolean | (() => boolean) } = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      sendDm: extras.sendDm ?? (async () => ok({ eventId: "evt", createdAt: new Date().toISOString() })),
    },
    bots: {
      list: async () =>
        ok({
          bots: (typeof extras.assistantHere === "function" ? extras.assistantHere() : extras.assistantHere)
            ? [
                {
                  name: "setup",
                  agentUid: ASSISTANT_UID,
                  ownerUid: "prs_test",
                  runtime: "claude",
                  state: "running",
                  pid: 11,
                  processAlive: true,
                  online: true,
                  lastHeartbeatAt: new Date().toISOString(),
                  daemonInstalled: true,
                  daemonLoaded: true,
                  dir: "/tmp/.hq/bots/setup",
                  workerId: "setup",
                },
              ]
            : [],
        }),
      listRemote: async () => ok({ bots: [] }),
      workers: async () => ok({ workers: [] }),
      probe: async () => ok({ ok: true, class: null }),
    },
    marketplace: {
      listListings: async () => ok({ listings: [] }),
    },
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    identity: {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: async () => ok(false),
      subscribeFeature: () => () => {},
    },
    appShell: {
      notificationPermissionState: async () => ok("default"),
    },
    settings: {
      getSettings: async () => ok({}),
    },
    library: {
      getRoot: async () => ok({ workers: [], skills: [] }),
      getCompany: async () => ok({ workers: [], skills: [] }),
      getWorkerDetail: async () => ok({}),
      getSkillDetail: async () => ok({}),
    },
  } as unknown as PlatformAdapter;
}

function queueHost(status: unknown): InstallQueueHost {
  return {
    getStatus: vi.fn(async () => status),
    retry: vi.fn(async () => null),
    listen: vi.fn(async () => () => {}),
  };
}

/** A queue host whose listener the test drives by hand. */
function liveQueueHost(initial: unknown) {
  let push: ((event: { payload: unknown }) => void) | null = null;
  const host: InstallQueueHost = {
    getStatus: vi.fn(async () => initial),
    retry: vi.fn(async () => null),
    listen: vi.fn(async (_event: string, cb: (event: { payload: unknown }) => void) => {
      push = cb;
      return () => {
        push = null;
      };
    }) as unknown as InstallQueueHost["listen"],
  };
  return {
    host,
    emit: (payload: unknown) => {
      if (!push) throw new Error("no progress listener registered");
      push({ payload });
    },
  };
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await tick();
}

async function mountShell(
  installQueue: InstallQueueHost | null,
  extras: Parameters<typeof webAdapter>[0] = {},
  flush: () => Promise<void> = settle,
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(extras),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test User", email: "test@example.com" },
      coreFixtures: false,
      installQueue,
    },
  });
  await flush();
}

describe("DesktopApp Finishing setup chip mount", () => {
  it("renders the chip next to the titlebar while the install queue is running", async () => {
    const queue = queueHost({
      state: "running",
      current: "GitHub CLI",
      currentId: "gh",
      done: 4,
      total: 11,
      failed: [],
    });
    await mountShell(queue);

    expect(queue.getStatus).toHaveBeenCalled();
    const slot = host.querySelector(".finishing-setup-slot");
    expect(slot).not.toBeNull();
    // The slot sits directly after the titlebar, outside the shell column flow.
    expect(slot?.previousElementSibling?.classList.contains("v4-titlebar")).toBe(true);
    const chip = slot?.querySelector('[data-testid="finishing-setup-chip"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("GitHub CLI");
  });

  it("renders no chip while the install queue is idle", async () => {
    const queue = queueHost({
      state: "idle",
      current: null,
      currentId: null,
      done: 0,
      total: 0,
      failed: [],
    });
    await mountShell(queue);

    expect(queue.getStatus).toHaveBeenCalled();
    expect(host.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("renders no chip when the host has no install queue", async () => {
    await mountShell(null);

    expect(host.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("a failed item never shows a count on the chip: the assistant is told once, with the item named (owner feedback 14)", async () => {
    const sendDm = vi.fn(async () => ok({ eventId: "evt", createdAt: new Date().toISOString() }));
    const queue = queueHost({
      state: "attention",
      current: null,
      currentId: null,
      done: 10,
      total: 11,
      failed: ["gh"],
    });
    await mountShell(queue, { sendDm, assistantHere: true });

    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, opts] = (sendDm.mock.calls as unknown as Array<[string, string, { idempotencyKey?: string }]>)[0]!;
    expect(to).toBe(ASSISTANT_UID);
    expect(body).toContain("did not finish: the GitHub CLI");
    // gh installs only through Homebrew, so the fix is Homebrew, not a relaunch.
    expect(body).toContain("needs Homebrew first");
    expect(opts.idempotencyKey).toBe("install-queue-attention:gh");
    // The vague pill is gone: nothing on the titlebar says "needs attention".
    expect(host.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
    expect(host.textContent).not.toContain("needs attention");
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("a failure that resolves before the assistant is known sends no stale notice (review, 2026-10-15)", async () => {
    vi.useFakeTimers();
    try {
      const sendDm = vi.fn(async () => ok({ eventId: "evt", createdAt: new Date().toISOString() }));
      let assistantHere = false;
      const attention = { state: "attention", current: null, currentId: null, done: 10, total: 11, failed: ["gh"] };
      const { host: queue, emit } = liveQueueHost(attention);
      // No assistant on this computer yet: the notice is held.
      const flush = async () => {
        for (let i = 0; i < 4; i += 1) {
          await tick();
          await vi.advanceTimersByTimeAsync(1);
        }
        await tick();
      };
      await mountShell(queue, { sendDm, assistantHere: () => assistantHere }, flush);
      await vi.advanceTimersByTimeAsync(50);
      expect(sendDm).not.toHaveBeenCalled();
      // The queue resumes and the item goes through.
      emit({ state: "running", current: "GitHub CLI", currentId: "gh", done: 10, total: 11, failed: [] });
      await vi.advanceTimersByTimeAsync(50);
      emit({ state: "complete", current: null, currentId: null, done: 11, total: 11, failed: [] });
      await vi.advanceTimersByTimeAsync(50);
      // Now the assistant is made here and the next listing shows it.
      assistantHere = true;
      await vi.advanceTimersByTimeAsync(LOCAL_BOTS_POLL_MS * 2);
      await flush();
      expect(sendDm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
