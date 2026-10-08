// @vitest-environment happy-dom

/**
 * Visual first-run setup (`setup.visualFirstRun`, slice 1). Flag off, a
 * first run is exactly today's: the setup bot starts by itself with the
 * setup chat's intro and kickoff. Flag on, the New bot step-through takeover
 * opens instead: the name the person confirms creates the setup bot once (in
 * the background), the coding tools step is required only without a signed-in
 * tool, and Done opens the assistant's chat with a kickoff that hands off the
 * settled steps. Done or "Continue in chat" means it never opens again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_BOT_KICKOFF, SETUP_BOT_NAMES, setupBotIntro } from "../chat/setup-bot.js";
import { VISUAL_FIRST_RUN_DONE_KEY, firstRunIntro, firstRunKickoff } from "../chat/first-run/visual-first-run.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

const SETUP_BOT_UID = "agt_setup";

interface AdapterOptions {
  create?: NonNullable<PlatformAdapter["bots"]>["create"];
  /** `setup.visualFirstRun`; undefined leaves `hasFeature` answering false for it. */
  flag?: boolean;
  claudeLoggedIn?: boolean;
}

function adapter({ create, flag = false, claudeLoggedIn = true }: AdapterOptions = {}) {
  const hasFeature = vi.fn(async (name: string) => ok(name === VISUAL_FIRST_RUN_FLAG ? flag : false));
  const updateAgentProfile = vi.fn(async () => ok({}));
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
    },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: true }),
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
      create: create ?? (async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID })),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
    },
  } as unknown as PlatformAdapter;
  return { platform, hasFeature, updateAgentProfile };
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

async function boot(platform: PlatformAdapter): Promise<void> {
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
