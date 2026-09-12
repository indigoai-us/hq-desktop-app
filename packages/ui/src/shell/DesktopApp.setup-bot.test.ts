// @vitest-environment happy-dom

/**
 * SETUP AS A LOCAL BOT (bots v2, step 3). On #welcome, Run Setup creates a
 * Local bot named `setup` from the core template and opens its DM instead of
 * starting the scripted `/setup` session: the bot's welcome is its first
 * message (sent by the runtime through `--intro`), and setup counts as run.
 * A `setup` bot that already exists is opened, never duplicated; a create that
 * fails says why, offers Retry, and still lets the person take the old
 * scripted route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createChatWakeBus, type ChatWakeBus } from "../chat/chat-api.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_BOT_COPY, SETUP_BOT_INTRO, SETUP_BOT_KICKOFF } from "../chat/setup-bot.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

const SETUP_BOT_UID = "agt_setup";

function setupBotRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: SETUP_BOT_UID,
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
    ...over,
  };
}

interface AdapterOptions {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>>;
  /** The setup bot's DM, oldest first; tests push the intro / answer here. */
  dm?: Array<Record<string, unknown>>;
  /** What `sessions.preflight` says about signed-in runtimes. */
  claudeLoggedIn?: boolean;
}

function adapter({ bots = {}, claudeLoggedIn = true, dm = [] }: AdapterOptions = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [...dm].reverse(), nextCursor: null }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    sessions: {
      preflight: async () =>
        ok({
          claudeAvailable: true,
          claudeLoggedIn,
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
    },
    bots: {
      list: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      ...bots,
    },
  } as unknown as PlatformAdapter;
}

/** The scripted run's engine: only used to prove the fallback still works. */
function fakeSetupRun(loggedIn = true) {
  const api: SetupRunApi = {
    preflight: vi.fn(async () => "ready" as const),
    start: vi.fn(async () => "sess-1"),
    attach: vi.fn(async () => true),
    subscribe: vi.fn((sessionId: string, cb: (snapshot: SetupRunSnapshot) => void) => {
      cb({ sessionId, events: [], phase: "starting" });
      return () => undefined;
    }),
    answerQuestion: vi.fn(async () => undefined),
    respondPermission: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    providers: vi.fn(async () => ({
      hqReady: true,
      claudeAvailable: true,
      claudeLoggedIn: loggedIn,
      codexAvailable: false,
      codexLoggedIn: false,
    })),
    providerLoginStart: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginStatus: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginCancel: vi.fn(async () => ({ state: "disconnected" as const })),
    providerInstallUrl: vi.fn(() => "https://claude.ai/download"),
    openExternal: vi.fn(async () => undefined),
  };
  return api;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

async function mountWelcome(platform: PlatformAdapter, setupRun: SetupRunApi, wakes?: ChatWakeBus): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: platform,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
      ...(wakes ? { wakes } : {}),
      extraPages: {
        sessions: {
          label: "Sessions",
          detail: "Local sessions",
          component: ExtraPageProbe,
          setupAction: { label: "Run Setup", param: () => "new?draft=x" },
          setupRun,
        },
      },
    },
  });
  await settle();
  const row = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
  expect(row, "pinned #welcome row renders").toBeTruthy();
  row!.click();
  await settle();
}

describe("#welcome Run Setup creates the setup bot", () => {
  it("creates `setup` from the core template with the welcome intro, opens its DM, and marks setup as run", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const scripted = fakeSetupRun();
    await mountWelcome(adapter({ bots: { create } }), scripted);

    const run = q<HTMLButtonElement>('[data-testid="setup-run"]')!;
    expect(run.textContent).toContain(SETUP_BOT_COPY.run);
    expect(q('[data-testid="setup-channel-intro"]')?.textContent).toContain("conversation with your setup bot");
    run.click();

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({
      name: "setup",
      worker: "setup",
      runtime: "claude",
      intro: SETUP_BOT_INTRO,
      // The bot starts step one by itself right after the intro.
      kickoff: SETUP_BOT_KICKOFF,
    });
    // The scripted `/setup` session is not started any more.
    expect(scripted.start).not.toHaveBeenCalled();
    // The bot's DM is the open conversation, with the progress card in it…
    await vi.waitFor(() => expect(q('[data-testid="bot-progress-card"]')).toBeTruthy());
    expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup");
    // …and setup counts as run, so a later boot lands in the company channel.
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
  });

  it("shows the bot thinking while it works on its first step, and clears it when that answer lands", async () => {
    const dm: Array<Record<string, unknown>> = [];
    const wakes = createChatWakeBus();
    await mountWelcome(adapter({ dm }), fakeSetupRun(), wakes);
    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    // Before the intro lands there is nothing to be thinking after.
    expect(q('[data-testid="agent-thinking-row"]')).toBeNull();

    // The runtime's intro arrives; the kickoff turn is now running.
    const at = Date.now();
    dm.push({
      eventId: "evt_intro",
      body: SETUP_BOT_INTRO,
      fromPersonUid: SETUP_BOT_UID,
      fromDisplayName: "setup",
      createdAt: new Date(at).toISOString(),
      direction: "in",
    });
    wakes.emit("mesh:catchup", { reason: "focus" });
    await vi.waitFor(() => expect(q('[data-testid="agent-thinking-row"]')?.textContent).toContain("setup is thinking"));

    // The first step's answer ends it.
    dm.push({
      eventId: "evt_step_one",
      body: "Here's what's set up already…",
      fromPersonUid: SETUP_BOT_UID,
      fromDisplayName: "setup",
      createdAt: new Date(at + 60_000).toISOString(),
      direction: "in",
    });
    wakes.emit("mesh:catchup", { reason: "focus" });
    await vi.waitFor(() => expect(q('[data-testid="agent-thinking-row"]')).toBeNull());
  });

  it("opens the setup bot that already exists instead of creating a second one", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await mountWelcome(
      adapter({ bots: { create, list: async () => ok({ bots: [setupBotRow()] }) } }),
      fakeSetupRun(),
    );

    const run = q<HTMLButtonElement>('[data-testid="setup-run"]')!;
    await vi.waitFor(() => expect(q('[data-testid="setup-run"]')?.textContent).toContain(SETUP_BOT_COPY.open));
    expect(q('[data-testid="setup-channel-intro"]')?.textContent).toContain("Your setup bot is in your messages");
    run.click();
    await settle();

    expect(create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
  });

  it("names the reason when the bot cannot be created, offers Retry, and keeps the scripted setup reachable", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      reason: "unavailable" as const,
      message: "Claude Code is not signed in.",
    }));
    const scripted = fakeSetupRun();
    await mountWelcome(adapter({ bots: { create } }), scripted);

    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="setup-bot-error"]')?.textContent).toContain("not signed in"));
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBeNull();

    // Retry runs the same create again.
    q<HTMLButtonElement>('[data-testid="setup-bot-retry"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    // And the old scripted run is still one click away.
    q<HTMLButtonElement>('[data-testid="setup-bot-fallback"]')!.click();
    await vi.waitFor(() => expect(scripted.start).toHaveBeenCalledWith("/setup --guided"));
    expect(q('[data-testid="setup-run-card"]')).toBeTruthy();
  });

  it("re-reads sign-in state at click time, so a tool connected this session is used", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const platform = adapter({ bots: { create } });
    // Nothing signed in at boot; Claude Code is connected through the Connect
    // step before the click, so the cached answer must not be believed.
    let signedIn = false;
    (platform as unknown as { sessions: { preflight: () => Promise<unknown> } }).sessions.preflight = async () =>
      ok({
        claudeAvailable: true,
        claudeLoggedIn: signedIn,
        codexAvailable: false,
        codexLoggedIn: false,
        grokAvailable: false,
        grokLoggedIn: false,
      });
    await mountWelcome(platform, fakeSetupRun());
    signedIn = true;

    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ runtime: "claude" }));
  });

  it("with no coding tool signed in, the Connect step still comes first", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await mountWelcome(adapter({ bots: { create }, claudeLoggedIn: false }), fakeSetupRun(false));

    await vi.waitFor(() => expect(q('[data-testid="setup-connect-step"]')).toBeTruthy());
    expect(q('[data-testid="setup-run"]')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
