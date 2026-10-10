// @vitest-environment happy-dom

/**
 * Visual first-run setup (`desktop.visual-first-run`, slice 1). Flag off, a
 * first run is exactly today's: the setup bot starts by itself with the
 * setup chat's intro and kickoff. Flag on, the New bot step-through takeover
 * opens instead: the name the person confirms creates the setup bot once (in
 * the background), the coding tools step is required only without a signed-in
 * tool, and Done opens the assistant's chat with a kickoff that hands off the
 * settled steps. Done or "Continue in chat" means it never opens again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_BOT_KICKOFF, SETUP_BOT_NAMES, setupBotIntro } from "../chat/setup-bot.js";
import {
  VISUAL_FIRST_RUN_DONE_KEY,
  VISUAL_FIRST_RUN_FLAG_GRACE_MS,
  firstRunHandoffNotice,
  firstRunImportNotice,
  firstRunIntro,
  firstRunKickoff,
} from "../chat/first-run/visual-first-run.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

const SETUP_BOT_UID = "agt_setup";

interface AdapterOptions {
  create?: NonNullable<PlatformAdapter["bots"]>["create"];
  /** `hq bot list` rows (a setup bot that already exists here). */
  bots?: unknown[];
  /** Answer `hasFeature` for the flag this way instead (timing tests). */
  hasFeatureImpl?: (name: string) => Promise<unknown>;
  /** Answer the host's setup status this way instead (timing tests). */
  setupStatusImpl?: () => Promise<unknown>;

  /** `desktop.visual-first-run`; undefined leaves `hasFeature` answering false for it. */
  flag?: boolean;
  claudeLoggedIn?: boolean;
  /** Answer `agent_session_preflight` this way instead. */
  preflightImpl?: () => Promise<unknown>;
}

function adapter({
  create,
  flag = false,
  claudeLoggedIn = true,
  bots = [],
  hasFeatureImpl,
  setupStatusImpl,
  preflightImpl,
}: AdapterOptions = {}) {
  const hasFeature = vi.fn(
    hasFeatureImpl ?? (async (name: string) => ok(name === VISUAL_FIRST_RUN_FLAG ? flag : false)),
  );
  const updateAgentProfile = vi.fn(async () => ok({}));
  const sendDm = vi.fn(async () => ok({ eventId: "evt_1", createdAt: new Date().toISOString() }));
  const platform = {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: { hasFeature, updateAgentProfile },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      sendDm,
    },
    settings: {
      getSetupStatus:
        setupStatusImpl ??
        (async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: true })),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    sessions: {
      preflight: preflightImpl ?? (async () =>
        ok({
          claudeAvailable: true,
          claudeLoggedIn,
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        })),
    },
    bots: {
      list: async () => ok({ bots }),
      create: create ?? (async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID })),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
    },
  } as unknown as PlatformAdapter;
  return { platform, hasFeature, updateAgentProfile, sendDm };
}

function fakeSetupRun(): SetupRunApi {
  return {
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
      claudeLoggedIn: true,
      codexAvailable: false,
      codexLoggedIn: false,
    })),
    providerLoginStart: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginStatus: vi.fn(async () => ({ state: "waiting" as const })),
    providerLoginCancel: vi.fn(async () => ({ state: "disconnected" as const })),
    providerInstallUrl: vi.fn(() => "https://claude.ai/download"),
    openExternal: vi.fn(async () => undefined),
  };
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
  document.querySelectorAll('[data-testid="first-run-takeover"]').forEach((el) => el.remove());
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

async function boot(
  platform: PlatformAdapter,
  App: typeof DesktopApp = DesktopApp,
  mountWith: typeof mount = mount,
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mountWith(App, {
    target: host,
    props: {
      adapter: platform,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
      extraPages: {
        sessions: {
          label: "Sessions",
          detail: "Local sessions",
          component: ExtraPageProbe,
          setupAction: { label: "Run Setup", param: () => "new?draft=x" },
          setupRun: fakeSetupRun(),
        },
      },
    },
  });
  await settle();
}

function step(): string | null {
  return q('[data-testid="first-run-step"]')?.getAttribute("data-step") ?? null;
}

function typeName(value: string): void {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(): void {
  q<HTMLInputElement>('[data-testid="new-bot-name"]')!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
}

describe("visual first run, flag off", () => {
  it("is today's first run, unchanged: the setup bot starts by itself with the setup chat's intro and kickoff", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: false });
    await boot(platform);

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(hasFeature).toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    const input = (create.mock.calls as unknown as Array<[{ displayName: string }]>)[0]![0];
    expect(SETUP_BOT_NAMES).toContain(input.displayName);
    expect(create).toHaveBeenCalledWith({
      name: "setup",
      displayName: input.displayName,
      worker: "setup",
      runtime: "claude",
      intro: setupBotIntro({ displayName: input.displayName }),
      kickoff: SETUP_BOT_KICKOFF,
    });
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="bot-progress-card"]')).toBeTruthy());
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBeNull();
  });

  it("does not ask for the flag at all once setup has run here", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: true });
    await boot(platform);
    await settle();
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("visual first run, flag on", () => {
  it("opens the takeover instead of the setup chat, and creates the assistant once, under the confirmed name", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true });
    await boot(platform);

    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(step()).toBe("name");
    // A friendly name is prefilled; nothing is created before it is confirmed.
    expect(SETUP_BOT_NAMES).toContain(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value);
    await settle();
    expect(create).not.toHaveBeenCalled();

    typeName("Biscuit");
    // Enter, a second Enter and a click on Next, as fast as a person can.
    pressEnter();
    pressEnter();
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')?.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      name: "setup",
      displayName: "Biscuit",
      worker: "setup",
      runtime: "claude",
      intro: firstRunIntro({ name: "Biscuit", runtime: "claude" }),
      kickoff: firstRunKickoff({ name: "Biscuit", runtime: "claude", toolsReady: ["claude"] }),
    });
    // The person is on the coding tools step while that runs.
    expect(step()).toBe("tools");

    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await settle();
    expect(step()).toBe("done");
    expect(q('[data-testid="first-run-summary-name"]')?.textContent).toBe("Biscuit");
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(q('[data-testid="first-run-talk"]')?.textContent).toContain("Talk to Biscuit");

    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await settle();
    // The assistant's chat is open, the takeover is gone for good.
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    // (The rail labels the setup bot's DM the same way today's flow does.)
    await vi.waitFor(() => expect(q('[data-testid="bot-progress-card"]')).toBeTruthy());
    expect(q('[data-testid="channel-name"]')?.textContent).toMatch(/Biscuit|setup/);
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
    // The legacy automatic start never ran alongside it.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a failed create says why; Retry creates again and the chat opens", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "unavailable" as const, message: "Claude Code is not signed in." })
      .mockResolvedValue(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create: create as never, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());

    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() =>
      expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("failed"),
    );
    expect(step()).toBe("done");
    expect(q('[data-testid="first-run-create-status"]')?.textContent).toContain("not signed in");
    expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(true);

    q<HTMLButtonElement>('[data-testid="first-run-retry"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a create that fails without a reason names the assistant, not the reserved handle", async () => {
    const create = vi.fn(async () => ({ ok: false as const, reason: "error" as const, message: "" }));
    const { platform } = adapter({ create: create as never, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() =>
      expect(q('[data-testid="first-run-create-status"]')?.textContent).toContain("Couldn't start Biscuit."),
    );
    expect(q('[data-testid="first-run-create-status"]')?.textContent).not.toContain("create setup");
  });

  it("without a signed-in coding tool nothing is created and the tools step is required", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true, claudeLoggedIn: false });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());

    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await settle();
    expect(step()).toBe("tools");
    expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(true);
    expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("waiting");
    expect(create).not.toHaveBeenCalled();
  });

  it("a readiness check that fails does not strand the tools step: each row offers Try again, which recovers", async () => {
    let fail = true;
    const preflightImpl = vi.fn(async () =>
      fail
        ? { ok: false as const, reason: "error", message: "Setup lookup timed out. Please retry." }
        : ok({
            claudeAvailable: true,
            claudeLoggedIn: true,
            codexAvailable: false,
            codexLoggedIn: false,
            grokAvailable: false,
            grokLoggedIn: false,
            claudeStatus: { state: "signedIn" },
            codexStatus: { state: "notInstalled", searched: [] },
          }),
    );
    const { platform } = adapter({ flag: true, preflightImpl });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
    await settle();
    expect(step()).toBe("tools");
    await vi.waitFor(() => expect(q('[data-testid="first-run-tool-claude"]')?.getAttribute("data-kind")).toBe("recheck"));
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeNull();
    expect(document.body.textContent).not.toContain("timed out");
    fail = false;
    q<HTMLButtonElement>('[data-testid="first-run-tool-claude-recheck"]')!.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-next"]')?.disabled).toBe(false));
    expect(q('[data-testid="first-run-tools-signin"]')).toBeNull();
  });

  it("Continue in chat leaves for #welcome, starts nothing by itself, and the takeover never opens again", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true, claudeLoggedIn: false });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());

    q<HTMLButtonElement>('[data-testid="first-run-continue-in-chat"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="setup-hero"]')).toBeTruthy());
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("visual first run, leaving for chat while the assistant is being created", () => {
  function deferredCreate() {
    let resolve!: (value: unknown) => void;
    const create = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    return { create, resolve: (value: unknown) => resolve(value) };
  }

  async function confirmAndLeave(name = "Biscuit"): Promise<void> {
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName(name);
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-continue-in-chat"]')!.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="setup-hero"]')).toBeTruthy());
  }

  it("#welcome holds its start while the first-run create runs, and never makes a second setup bot", async () => {
    const pending = deferredCreate();
    const { platform } = adapter({ create: pending.create as never, flag: true });
    await boot(platform);
    await confirmAndLeave();
    await vi.waitFor(() => expect(pending.create).toHaveBeenCalledTimes(1));

    // The start button says the setup bot is starting and holds, and the
    // hero does not promise a conversation that opens by itself.
    expect(q('[data-testid="setup-hero"]')?.textContent).toContain("Biscuit is starting on this computer.");
    const run = q<HTMLButtonElement>('[data-testid="setup-run"]')!;
    expect(run.disabled).toBe(true);
    run.click();
    await settle();

    pending.resolve(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await settle();
    // Once it lands the button opens that bot; it still never creates again.
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="setup-run"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await settle();
    expect(pending.create).toHaveBeenCalledTimes(1);
  });

  it("a create that lands after Continue in chat leaves the person on #welcome", async () => {
    const pending = deferredCreate();
    const { platform } = adapter({ create: pending.create as never, flag: true });
    await boot(platform);
    await confirmAndLeave();
    await vi.waitFor(() => expect(pending.create).toHaveBeenCalledTimes(1));
    expect(q('[data-testid="channel-name"]')?.textContent).toContain("welcome");

    pending.resolve(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await settle(12);
    expect(q('[data-testid="channel-name"]')?.textContent).toContain("welcome");
    expect(q('[data-testid="setup-hero"]')).toBeTruthy();
  });

  it("after a failed create, #welcome's start uses the name the person confirmed", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "error" as const, message: "Claude Code is not signed in." })
      .mockResolvedValue(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create: create as never, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() =>
      expect(q('[data-testid="first-run-create-status"]')?.getAttribute("data-state")).toBe("failed"),
    );
    q<HTMLButtonElement>('[data-testid="first-run-failed-chat"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="setup-hero"]')).toBeTruthy());
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="setup-run"]')?.disabled).toBe(false));

    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).toEqual(expect.objectContaining({ displayName: "Biscuit", worker: "setup" }));
  });
});

describe("visual first run, names with stray whitespace", () => {
  it("sends the collapsed name the host checks, to the create, the hello and the kickoff", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName(" Mr\tBiscuit  Pants ");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls as unknown as Array<[{ displayName: string; intro: string; kickoff: string }]>)[0]![0];
    expect(input.displayName).toBe("Mr Biscuit Pants");
    expect(input.intro).toContain("Hi, I'm Mr Biscuit Pants,");
    expect(input.kickoff).toContain('"name":"Mr Biscuit Pants"');
    expect(input.kickoff).not.toMatch(/\t|  /);
  });
});

describe("visual first run, a flag that cannot be read", () => {
  for (const [label, answer] of [
    ["rejects", () => Promise.reject(new Error("registry down"))],
    ["answers not ok", () => Promise.resolve({ ok: false as const, reason: "error" as const, message: "nope" })],
  ] as const) {
    it(`a flag read that ${label} is off: today's setup bot starts by itself, once`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const { platform } = adapter({
        create,
        hasFeatureImpl: (name) => (name === VISUAL_FIRST_RUN_FLAG ? answer() : Promise.resolve(ok(false))),
      });
      await boot(platform);
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      await settle();
      expect(create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ kickoff: SETUP_BOT_KICKOFF }));
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      warn.mockRestore();
    });
  }
});

describe("visual first run never reappears", () => {
  it("after Done (setup marked run too): no takeover, no flag read, nothing created", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: true });
    await boot(platform);
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(create).not.toHaveBeenCalled();
  });

  it("after Continue in chat: no takeover; the next launch is today's setup chat start", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kickoff: SETUP_BOT_KICKOFF }));
  });
});

describe("visual first run with a setup bot that already exists", () => {
  it("adopts it under the confirmed name and sends it the handoff as a bot-only message", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const existing = {
      name: "setup",
      agentUid: SETUP_BOT_UID,
      ownerUid: "prs_test",
      runtime: "claude",
      state: "running",
      pid: 11,
      processAlive: true,
      online: true,
      lastHeartbeatAt: null,
      daemonInstalled: true,
      daemonLoaded: true,
      dir: "/tmp/HQ/personal/workers/setup",
      workerId: "setup",
    };
    const { platform, sendDm, updateAgentProfile } = adapter({ create, flag: true, bots: [existing] });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));

    expect(create).not.toHaveBeenCalled();
    expect(updateAgentProfile).toHaveBeenCalledWith(SETUP_BOT_UID, { displayName: "Biscuit" });
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    expect(body).toBe(
      firstRunHandoffNotice({ name: "Biscuit", runtime: "claude", toolsReady: ["claude"] }, { noun: "computer" }),
    );
  });
});

describe("visual first run: Bring in your context", () => {
  const IMPORTED = { summary: { companies: 0, projects: 0, sessions: 12 }, report: "workspace/reports/import.json" };

  /**
   * Boot with the flag on, name the assistant, run the scan to its end, and
   * hand over a finished import. Timers are fake from the scan on, so the
   * notice ledger's waits can be stepped through.
   */
  async function finishAScan(firstSend: () => Promise<unknown>) {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, sendDm } = adapter({ create, flag: true });
    const handlers = new Set<(e: { payload?: unknown }) => void>();
    const syncEvents = {
      listen: vi.fn(async (_event: string, h: (e: { payload?: unknown }) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      }),
      emit: vi.fn(async () => undefined),
    };
    let finishScan: (v: unknown) => void = () => undefined;
    const scanStart = vi.fn((_scanId: string) => new Promise((resolve) => (finishScan = resolve)));
    const scanCancel = vi.fn(async () => ok(true));
    (platform as unknown as Record<string, unknown>).contextImport = { scanStart, scanCancel };
    sendDm.mockImplementationOnce(firstSend as never);

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
        syncEvents: syncEvents as never,
        extraPages: {
          sessions: {
            label: "Sessions",
            detail: "Local sessions",
            component: ExtraPageProbe,
            setupAction: { label: "Run Setup", param: () => "new?draft=x" },
            setupRun: fakeSetupRun(),
          },
        },
      },
    });
    await settle();

    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    typeName("Biscuit");
    pressEnter();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await settle();
    expect(step()).toBe("context");
    await vi.waitFor(() => expect(q('[data-testid="first-run-import-start"]')).toBeTruthy(), { timeout: 3000 });
    q<HTMLButtonElement>('[data-testid="first-run-import-start"]')!.click();
    await vi.waitFor(() => expect(scanStart).toHaveBeenCalledTimes(1));
    // The ledger reads Date.now(), so the clock moves with the timers.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const scanId = scanStart.mock.calls[0]![0];
    const lines = [
      { type: "start", sources: [{ id: "claude-code", label: "Claude Code" }] },
      { type: "source", id: "claude-code", status: "done", counts: { sessions: 12 } },
      { type: "done", report: "workspace/reports/import.json", summary: { companies: 0, projects: 0, sessions: 12 } },
    ];
    for (const line of lines) handlers.forEach((h) => h({ payload: { scanId, event: { v: 1, ...line } } }));
    finishScan(ok({ status: "done", lines: 3, dropped: 0 }));
    // The host's short tail wait, then the notice.
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    return { sendDm, scanCancel };
  }

  function expectImportNotices(sendDm: ReturnType<typeof vi.fn>) {
    for (const call of sendDm.mock.calls) {
      const [to, body, extras] = call as unknown as [string, string, Record<string, unknown>];
      expect(to).toBe(SETUP_BOT_UID);
      expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-import:${SETUP_BOT_UID}` });
      expect(body).toBe(firstRunImportNotice(IMPORTED));
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("hands the finished import to the assistant once, as a bot-only note, trying a failed send again after the ledger's wait", async () => {
    const { sendDm, scanCancel } = await finishAScan(async () => failure("network", "offline"));
    expect(sendDm).toHaveBeenCalledTimes(1);
    // Not before the notice ledger allows it (30 s after a failure that may pass).
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(2);
    expectImportNotices(sendDm);

    // Delivered: nothing more goes, however long it waits, and Next: Done sends nothing.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    q<HTMLButtonElement>('[data-testid="first-run-next"]')!.click();
    await settle();
    expect(step()).toBe("done");
    expect(sendDm).toHaveBeenCalledTimes(2);
    expect(scanCancel).not.toHaveBeenCalled();
  });

  it("a send the server refuses (403) is not tried again", async () => {
    const { sendDm } = await finishAScan(async () => ({ ok: false, reason: "forbidden", code: "http-403" }));
    expect(sendDm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(1);
    expectImportNotices(sendDm);
  });

  it("a pending try is called off when the shell goes away", async () => {
    const { sendDm } = await finishAScan(async () => failure("network", "offline"));
    expect(sendDm).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await unmount(component!);
    component = null;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendDm).toHaveBeenCalledTimes(1);
  });
});

describe("the flag read overlaps the setup-owed check (fake timers)", () => {
  const OWED_AT_MS = 500;
  const delayed = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
  const owedLater = () =>
    delayed(OWED_AT_MS, ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: true }));

  /**
   * `hasFeature` where only this flag is slow (off after `ms`, or never with
   * null); every other flag answers off at once, as in the other tests.
   */
  const flagAfter =
    (ms: number | null) =>
    (name: string): Promise<unknown> => {
      if (name !== VISUAL_FIRST_RUN_FLAG || ms === 0) return Promise.resolve(ok(false));
      return ms === null ? new Promise(() => {}) : delayed(ms, ok(false));
    };

  /** Milliseconds from mount until the setup bot's automatic start. */
  async function startTime(options: AdapterOptions): Promise<number> {
    window.localStorage.clear();
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ ...options, create, setupStatusImpl: owedLater });
    // A fresh shell module each time: the shell keeps some boot state at
    // module level, and a second mount in one test would boot faster.
    // (Svelte itself is re-imported with it, so the two share one runtime.)
    vi.resetModules();
    const svelte = await import("svelte");
    const fresh = (await import("./DesktopApp.svelte")).default;
    await boot(platform, fresh, svelte.mount);
    let elapsed = 0;
    while (create.mock.calls.length === 0 && elapsed < 6000) {
      await vi.advanceTimersByTimeAsync(25);
      await settle(4);
      elapsed += 25;
    }
    await svelte.unmount(component!);
    component = null;
    host.remove();
    return elapsed;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a flag that answers before the setup-owed answer adds no wait; a slow one adds at most the grace", async () => {
    // Today's timing: a flag that is off the moment it is asked.
    const baseline = await startTime({ hasFeatureImpl: flagAfter(0) });
    // Off, answered at 400 ms: before the owed answer at 500 ms.
    const answeredFirst = await startTime({
      hasFeatureImpl: flagAfter(400),
    });
    // Off, answered at 1200 ms: the waits overlap, so not 500 + 1200.
    const answeredLater = await startTime({
      hasFeatureImpl: flagAfter(1200),
    });
    // Never answers: off once the grace past the owed answer runs out.
    // (Read in sequence, a 1200 ms flag would have started at 1700 ms.)
    const neverAnswers = await startTime({ hasFeatureImpl: flagAfter(null) });

    expect(answeredFirst).toBe(baseline);
    expect(baseline).toBeGreaterThanOrEqual(OWED_AT_MS);
    expect(answeredLater).toBeLessThanOrEqual(1200 + 50);
    expect(answeredLater).toBeLessThan(OWED_AT_MS + 1200);
    expect(neverAnswers).toBeGreaterThan(baseline);
    expect(neverAnswers).toBeLessThanOrEqual(baseline + VISUAL_FIRST_RUN_FLAG_GRACE_MS + 50);
  });
});
