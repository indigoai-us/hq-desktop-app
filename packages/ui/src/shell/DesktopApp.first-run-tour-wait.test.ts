// @vitest-environment happy-dom

/**
 * The visual first run waits for the account's bot listing before its name
 * step opens (so a returning account is offered its assistant's own name).
 * The guided tour must not start by itself in that wait, on top of a takeover
 * about to open.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { TOUR_AUTO_START_DELAY_MS } from "../tour/guided-tour.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document.querySelectorAll('[data-testid="first-run-takeover"]').forEach((el) => el.remove());
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const SETUP_BOT: LocalBotRow = {
  name: "setup",
  agentUid: "agt_setup_tour_wait",
  ownerUid: "prs_test",
  runtime: "claude",
  state: "running",
  pid: 11,
  processAlive: true,
  online: false,
  lastHeartbeatAt: null,
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/setup",
  workerId: "setup",
};

describe("visual first run waiting on the bot listing", () => {
  it("the guided tour does not start while the takeover waits for the listing", async () => {
    let answer: (v: unknown) => void = () => undefined;
    const listRemote = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const adapter = {
      kind: "desktop",
      isAvailable: () => false,
      capabilities: {},
      messaging: {
        listContacts: async () => ok({ contacts: [] }),
        listChannelMembers: async () => ok({ members: [] }),
        fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
        fetchDmThread: async () => ({ ok: false as const, reason: "unavailable" }),
      },
      files: { listDir: async () => ok([]) },
      identity: { hasFeature: async (name: string) => ok(name === VISUAL_FIRST_RUN_FLAG) },
      bots: {
        list: async () => ok({ bots: [SETUP_BOT] }),
        listRemote,
        create: async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT.agentUid }),
        start: async () => ok({}),
        stop: async () => ok({}),
        remove: async () => ok({}),
        workers: async () => ok({ workers: [] }),
        probe: async () => ok({ ok: true, class: null }),
      },
      appShell: { setActiveCompany: async () => ok(undefined) },
      settings: {
        getSetupStatus: async () =>
          ok({
            hqRootValid: true,
            configured: true,
            hqFolderPath: "/tmp/HQ",
            welcomeSetupOwed: true,
            welcomeTourShown: false,
          }),
        markWelcomeTourShown: async () => ok(undefined),
      },
      shell: {
        detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
      },
      sessions: {
        preflight: async () =>
          ok({
            claudeAvailable: true,
            claudeLoggedIn: true,
            codexAvailable: false,
            codexLoggedIn: false,
            grokAvailable: false,
            grokLoggedIn: false,
          }),
      },
    } as unknown as PlatformAdapter;

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(DesktopApp, {
      target: host,
      props: {
        adapter,
        sidebarApi: createFixtureChatSidebarApi(),
        notificationsApi: createEmptyNotificationsApi(),
        self: { uid: "prs_test", displayName: "Ada Lovelace", email: "ada@example.com" },
        coreFixtures: false,
      },
    });
    await settle();

    await new Promise((r) => setTimeout(r, TOUR_AUTO_START_DELAY_MS + 400));
    await settle();
    expect(listRemote).toHaveBeenCalled();
    expect(q("first-run-takeover")).toBeNull();
    expect(q("guided-tour-card")).toBeNull();

    answer(ok({ bots: [] }));
    await vi.waitFor(() => expect(q("first-run-takeover")).toBeTruthy(), { timeout: 2000, interval: 20 });
    expect(q("guided-tour-card")).toBeNull();
  });
});
