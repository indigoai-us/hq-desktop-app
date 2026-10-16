// @vitest-environment happy-dom

/**
 * Visual first-run setup (`desktop.visual-first-run`, slice 1). Flag off, a
 * first run is exactly today's: the setup bot starts by itself with the
 * setup chat's intro and kickoff. Flag on, the New bot step-through takeover
 * opens instead: the name the person confirms creates the setup bot once (in
 * the background), the coding tools step is required only without a signed-in
 * tool. The create runs no kickoff: the assistant runs no turn while the
 * takeover is open, and Done (or "Continue in chat") sends it one bot-only
 * note with everything the takeover settled. Done or "Continue in chat"
 * means it never opens again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, FIRST_RUN_FOUND_APPS_FLAG, ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_BOT_KICKOFF, SETUP_BOT_NAMES, setupBotIntro } from "../chat/setup-bot.js";
import {
  VISUAL_FIRST_RUN_DONE_KEY,
  VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS,
  VISUAL_FIRST_RUN_FLAG_LATE_WINDOW_MS,
  FIRST_RUN_LISTINGS_WAIT_MS,
  firstRunHandoffNotice,
  firstRunIntro,
} from "../chat/first-run/visual-first-run.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";
import {
  CONVERSATION_START_GRACE_MS,
  fromConversationStart,
  readConversationStarts,
} from "../chat/first-run/conversation-start.js";

const SETUP_BOT_UID = "agt_setup";

interface AdapterOptions {
  create?: NonNullable<PlatformAdapter["bots"]>["create"];
  /** `hq bot list` rows (a setup bot that already exists here). */
  bots?: unknown[];
  /** Answer `hq bot list` this way instead (a slow listing). */
  listImpl?: () => Promise<unknown>;
  /** Answer `hasFeature` for the flag this way instead (timing tests). */
  hasFeatureImpl?: (name: string) => Promise<unknown>;
  /** Answer the host's setup status this way instead (timing tests). */
  setupStatusImpl?: () => Promise<unknown>;

  /** `desktop.visual-first-run`; undefined leaves `hasFeature` answering false for it. */
  flag?: boolean;
  claudeLoggedIn?: boolean;
  /** Answer `agent_session_preflight` this way instead. */
  preflightImpl?: () => Promise<unknown>;
  /** `hq bot probe` (the real sign-in check); null leaves the host without it. Passes by default. */
  probe?: ((runtime: string) => Promise<unknown>) | null;
  /** The tool's browser sign-in (`agent_provider_login_start` / status). */
  loginStart?: (runtime: string, opts?: { force?: boolean }) => Promise<unknown>;
  loginStatus?: (runtime: string) => Promise<unknown>;
  /** `hq bot list --remote` (the account's own listing); absent leaves the host without it. */
  listRemote?: () => Promise<unknown>;
  /** The host's hq-sync.log writer; absent leaves the host without one. */
  logToFile?: (tag: string, message: string) => Promise<unknown>;
}

function adapter({
  create,
  flag = false,
  claudeLoggedIn = true,
  bots = [],
  hasFeatureImpl,
  setupStatusImpl,
  preflightImpl,
  probe = async () => ok({ ok: true, class: null }),
  loginStart,
  loginStatus,
  listRemote,
  listImpl,
  logToFile,
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
    ...(logToFile ? { appShell: { logToFile } } : {}),
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
      ...(loginStart ? { loginStart } : {}),
      ...(loginStatus ? { loginStatus } : {}),
    },
    bots: {
      list: listImpl ?? (async () => ok({ bots })),
      create: create ?? (async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID })),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      ...(probe ? { probe } : {}),
      ...(listRemote ? { listRemote } : {}),
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
  extraProps: Record<string, unknown> = {},
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
      ...extraProps,
    },
  });
  await settle();
}

function step(): string | null {
  return q('[data-testid="first-run-step"]')?.getAttribute("data-step") ?? null;
}

/** The decision is on screen (it renders inside the lazily loaded context scene). */
async function decisionShown(): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="first-run-decision-question"]')).toBeTruthy(), { timeout: 5000 });
}

/** Take the bot path: with a signed-in coding tool the takeover opens on the tool path. */
async function chooseBot(): Promise<void> {
  await decisionShown();
  if (q('[data-testid="first-run-decision"]')?.getAttribute("data-path") === "tool") {
    q<HTMLButtonElement>('[data-testid="first-run-decision-other"]')!.click();
    await settle();
  }
  expect(q('[data-testid="first-run-decision"]')?.getAttribute("data-path")).toBe("bot");
}

function typeName(value: string): void {
  const input = q<HTMLInputElement>('[data-testid="first-run-bot-name"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The bot path's one action: Continue confirms the name. */
function confirmName(): void {
  q<HTMLButtonElement>('[data-testid="first-run-decision-primary"]')!.click();
}

/** A log writer that keeps the `[first-run]` lines in order. */
function logSink() {
  const lines: string[] = [];
  const logToFile = vi.fn(async (tag: string, message: string) => {
    if (tag === "first-run") lines.push(message);
    return ok(undefined);
  });
  return { lines, logToFile, of: (kind: string) => lines.filter((line) => line.startsWith(`kind=${kind} `)) };
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
    const { platform, sendDm } = adapter({ create, flag: true });
    await boot(platform);

    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(step()).toBe("decision");
    await chooseBot();
    // A friendly name is prefilled; nothing is created before it is confirmed.
    expect(SETUP_BOT_NAMES).toContain(q<HTMLInputElement>('[data-testid="first-run-bot-name"]')?.value);
    await settle();
    expect(create).not.toHaveBeenCalled();

    typeName("Biscuit");
    // Continue twice, as fast as a person can.
    confirmName();
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      name: "setup",
      displayName: "Biscuit",
      worker: "setup",
      runtime: "claude",
      // No sign-in check runs in the first run, so the hello does not claim one.
      intro: firstRunIntro({ name: "Biscuit", runtime: "claude", signInChecked: false }),
    });
    expect(step()).toBe("done");
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(q('[data-testid="first-run-talk"]')?.textContent).toContain("Talk to Biscuit");

    expect(sendDm).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await settle();
    // The assistant gets everything the takeover settled, in one note, now.
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect((sendDm.mock.calls[0] as unknown as [string, string])[1]).toBe(
      firstRunHandoffNotice(
        { name: "Biscuit", runtime: "claude", toolsReady: ["claude"], signInChecked: false, team: null, apps: {} },
        { noun: "computer" },
      ),
    );
    // The assistant's chat is open, the takeover is gone for good.
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    // (The rail labels the setup bot's DM the same way today's flow does.)
    await vi.waitFor(() => expect(q('[data-testid="bot-progress-card"]')).toBeTruthy());
    expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Biscuit");
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

    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(q('[data-testid="first-run-done-failed"]')).toBeTruthy());
    expect(step()).toBe("done");
    expect(q('[data-testid="first-run-done-failed"]')?.textContent).toContain("not signed in");
    expect(q('[data-testid="first-run-talk"]')).toBeNull();

    q<HTMLButtonElement>('[data-testid="first-run-done-retry"]')!.click();
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
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() =>
      expect(q('[data-testid="first-run-done-failed"]')?.textContent).toContain("Couldn't start Biscuit."),
    );
    expect(q('[data-testid="first-run-done-failed"]')?.textContent).not.toContain("create setup");
  });

  it("without a signed-in coding tool only the bot path shows; naming it still makes the assistant here (owner, 2026-10-15)", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true, claudeLoggedIn: false });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await decisionShown();

    expect(q('[data-testid="first-run-decision"]')?.getAttribute("data-path")).toBe("bot");
    expect(q('[data-testid="first-run-decision-other"]')).toBeNull();
    typeName("Biscuit");
    confirmName();
    await settle();
    expect(step()).toBe("done");
    // Created on the installed tool; its chat asks for the sign-in it needs.
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toEqual(
      expect.objectContaining({ displayName: "Biscuit", runtime: "claude" }),
    );
    expect(q('[data-testid="first-run-done-continue"]')).toBeNull();
  });

  // US-007 removed the Coding tools step and its real sign-in check: sign-in
  // state is the stored login, read without a model turn.
  it("runs no sign-in probe and shows no coding tools or defaults step; the hello and the note do not claim a sign-in", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const probe = vi.fn(async () => ok({ ok: true, class: null }));
    const { platform, sendDm } = adapter({ create, flag: true, probe });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await chooseBot();
    const text = q('[data-testid="first-run-takeover"]')?.textContent ?? "";
    expect(text).not.toContain("Coding tools");
    expect(text).not.toContain("Finish with defaults");
    expect(text).not.toContain("Bring it in");
    typeName("Popcorn");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls[0] as unknown[])[0] as { intro: string; kickoff?: string };
    expect(input.intro).toBe(firstRunIntro({ name: "Popcorn", runtime: "claude", signInChecked: false }));
    expect(input.intro).not.toContain("signed in");
    expect(input.kickoff).toBeUndefined();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const body = (sendDm.mock.calls[0] as unknown as [string, string])[1];
    expect(body).not.toContain("Claude Code is signed in");
    expect(body).toContain("HQ could not confirm its sign-in");
    expect(probe).not.toHaveBeenCalled();
  });

  it("Continue in the coding tool leaves for #welcome, starts nothing by itself, and the takeover never opens again", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await decisionShown();

    expect(q('[data-testid="first-run-decision"]')?.getAttribute("data-path")).toBe("tool");
    expect(q('[data-testid="first-run-decision-question"]')?.textContent).toBe("Where do you want to keep working?");
    const primary = q<HTMLButtonElement>('[data-testid="first-run-decision-primary"]')!;
    expect(primary.textContent).toContain("Continue in Claude Code");
    primary.click();
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="setup-hero"]')).toBeTruthy());
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
    await settle();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("visual first run, a name confirmed with no signed-in tool", () => {
  /** Signed out at the first readiness read, signed in on every later one. */
  function signsInLater() {
    let calls = 0;
    return vi.fn(async () => {
      calls += 1;
      const signedIn = calls > 1;
      return ok({
        claudeAvailable: true,
        claudeLoggedIn: signedIn,
        codexAvailable: false,
        codexLoggedIn: false,
        grokAvailable: false,
        grokLoggedIn: false,
      });
    });
  }

  // Before 2026-10-15 the create waited for a sign-in and #welcome's start
  // made the assistant later under the confirmed name. The owner's rule now:
  // the assistant is made here at once and its own chat asks for the sign-in.
  it("creates the assistant at once under the confirmed name, with no kickoff, and the takeover's note goes when it closes", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, sendDm } = adapter({ create, flag: true, preflightImpl: signsInLater() });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toEqual(expect.objectContaining({ displayName: "Biscuit", worker: "setup", runtime: "claude" }));
    expect(input).not.toHaveProperty("kickoff");
    expect(sendDm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    expect(body).toContain('"name":"Biscuit"');
    expect(body).toContain('"runtime":"claude"');
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
  });
});

describe("visual first run, names with stray whitespace", () => {
  it("sends the collapsed name the host checks, to the create, the hello and the handoff note", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, sendDm } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await chooseBot();
    typeName(" Mr\tBiscuit  Pants ");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = (create.mock.calls as unknown as Array<[{ displayName: string; intro: string; kickoff?: string }]>)[0]![0];
    expect(input.displayName).toBe("Mr Biscuit Pants");
    expect(input.intro).toContain("Hi, I'm Mr Biscuit Pants,");
    expect(input.kickoff).toBeUndefined();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const body = (sendDm.mock.calls[0] as unknown as [string, string])[1];
    expect(body).toContain('"name":"Mr Biscuit Pants"');
    expect(body).not.toMatch(/\t|  /);
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
  // Leaving the takeover leaves its assistant on this computer: the listing
  // that tells this install's marker from a reinstall's leftover.
  const assistantHere = {
    name: "setup",
    agentUid: SETUP_BOT_UID,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    online: true,
    dir: "/tmp/HQ/personal/workers/setup",
  };

  it("after Done (setup marked run too): no takeover, no flag read, nothing created", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: true, bots: [assistantHere] });
    await boot(platform);
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(create).not.toHaveBeenCalled();
  });

  it("after Continue in chat, with the assistant here: no takeover; the next launch is today's start, which opens the assistant", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform, hasFeature } = adapter({ create, flag: true, bots: [assistantHere] });
    await boot(platform);
    await vi.waitFor(() => expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1"));
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
  });

  it("after Continue in chat where the assistant was never made here: the takeover opens again (this computer cannot tell it from a reinstall)", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const { platform } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBeNull();
  });
});

describe("visual first run with a setup bot that already exists", () => {
  it("adopts it under the confirmed name and sends it the handoff as a bot-only message, only once the takeover closes", async () => {
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
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));

    expect(create).not.toHaveBeenCalled();
    expect(updateAgentProfile).toHaveBeenCalledWith(SETUP_BOT_UID, { displayName: "Biscuit" });
    // Nothing while the takeover is open: a note now would be answered now.
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    const [to, body, extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
    expect(body).toBe(
      firstRunHandoffNotice(
        { name: "Biscuit", runtime: "claude", toolsReady: ["claude"], signInChecked: false, team: null, apps: {} },
        { noun: "computer" },
      ),
    );
  });
});

describe("visual first run: the name step on an account that already has an assistant", () => {
  /** The account's assistant as `hq bot list --remote` shows it on a new computer. */
  function cloudAssistant(fields: Record<string, unknown> = {}) {
    return {
      name: "setup",
      displayName: "Fluffy",
      role: "assistant",
      agentUid: SETUP_BOT_UID,
      kind: "personal",
      online: false,
      lastHeartbeatAt: null,
      here: false,
      ...fields,
    };
  }

  /** The bot name field's value, read on the bot path. */
  async function nameField(): Promise<string | undefined> {
    await chooseBot();
    return q<HTMLInputElement>('[data-testid="first-run-bot-name"]')?.value;
  }

  it("a returning account on a new computer: the name field opens with the assistant's cloud name, and Continue keeps it", async () => {
    const create = vi.fn(async () => ok({ ok: true, outcome: "adopted", name: "setup", agentUid: SETUP_BOT_UID }));
    // The listing answers after the flag and the setup-owed answer, as it
    // can on a real network: the name step waits for it.
    let answer: (v: unknown) => void = () => undefined;
    const listRemote = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    const { platform } = adapter({ create, flag: true, listRemote });
    await boot(platform);
    await settle(20);
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();

    answer(ok({ bots: [cloudAssistant()] }));
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(step()).toBe("decision");
    expect(await nameField()).toBe("Fluffy");

    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "setup", displayName: "Fluffy" }));
  });

  // Cold VM run of a01028e3e, path B: a cold reset and reinstall on the same
  // computer (no ~/.hq, no ~/hq, same machine id). The account's assistant was
  // bound to this machine id, so the account's listing said here=true, and the
  // desktop landed in #welcome with no takeover.
  it("a cold re-install on the same computer: the last install's finished marker, no bots here, setup owed: the takeover opens again", async () => {
    // The window's storage outlives a reinstall that wipes ~/.hq and the HQ
    // folder, so the earlier install's markers are still there.
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, outcome: "adopted", name: "setup", agentUid: SETUP_BOT_UID }));
    const listRemote = vi.fn(async () => ok({ bots: [cloudAssistant({ displayName: "Pebble", here: true, online: true })] }));
    const { platform, hasFeature } = adapter({ create, flag: true, listRemote });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(hasFeature).toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(step()).toBe("decision");
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBeNull();
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBeNull();
    expect(await nameField()).toBe("Pebble");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "setup", displayName: "Pebble" }));
  });

  it("a cold re-install where the coding tool is signed out: the takeover still opens, and nothing starts the setup chat behind it", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, outcome: "adopted", name: "setup", agentUid: SETUP_BOT_UID }));
    const listRemote = vi.fn(async () => ok({ bots: [cloudAssistant({ displayName: "Pebble", here: true, online: true })] }));
    const { platform } = adapter({ create, flag: true, listRemote, claudeLoggedIn: false });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBeNull();
  });

  it("the same install, finished and with its assistant here: the marker holds and the takeover stays closed", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    const bots = [{ name: "setup", agentUid: SETUP_BOT_UID, displayName: "Pebble", online: true, runtime: "claude" }];
    const { platform, hasFeature } = adapter({ create, flag: true, bots });
    await boot(platform);
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
  });

  it("a finished marker where the host says setup is done: the marker holds", async () => {
    window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
    const { platform } = adapter({
      flag: true,
      setupStatusImpl: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: false }),
    });
    await boot(platform);
    await settle();
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
  });

  it("a cloud row that carries only the handle is never offered as the name", async () => {
    const listRemote = vi.fn(async () =>
      ok({ bots: [cloudAssistant({ name: "setup-ab12cd34", displayName: "setup-ab12cd34" })] }),
    );
    const { platform } = adapter({ flag: true, listRemote });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(SETUP_BOT_NAMES).toContain(await nameField());
  });

  it("a fresh account with no assistant anywhere gets a friendly free name", async () => {
    const listRemote = vi.fn(async () => ok({ bots: [] }));
    const { platform } = adapter({ flag: true, listRemote });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(listRemote).toHaveBeenCalled();
    expect(SETUP_BOT_NAMES).toContain(await nameField());
  });

  it("a listing that fails still opens the step with a friendly free name, and shows nothing of the failure", async () => {
    const listRemote = vi.fn(async () => failure("unavailable", "hq bot list --remote: 500 Internal Server Error"));
    const { platform } = adapter({ flag: true, listRemote });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(SETUP_BOT_NAMES).toContain(await nameField());
    expect(q('[data-testid="first-run-takeover"]')?.textContent ?? "").not.toMatch(/500|Internal Server Error/);
  });

  it("an account listing that never answers holds the step for at most the first run's wait, then a free name", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listRemote = vi.fn(() => new Promise(() => undefined));
      const { platform } = adapter({ flag: true, listRemote });
      await boot(platform);
      await settle(20);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(FIRST_RUN_LISTINGS_WAIT_MS - 1000);
      await settle(10);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1100);
      await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
      expect(SETUP_BOT_NAMES).toContain(await nameField());
    } finally {
      vi.useRealTimers();
    }
  });

  it("this computer's bot list never answering also holds the step for at most the first run's wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listRemote = vi.fn(async () => ok({ bots: [] }));
      const { platform } = adapter({ flag: true, listRemote });
      (platform.bots as unknown as Record<string, unknown>).list = vi.fn(() => new Promise(() => undefined));
      await boot(platform);
      await settle(20);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(FIRST_RUN_LISTINGS_WAIT_MS + 100);
      await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
      expect(SETUP_BOT_NAMES).toContain(await nameField());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a finished marker while this computer's bot list never answers", () => {
  it("keeps the marker after the first run's wait, so the route leaves pending for the normal app", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem(VISUAL_FIRST_RUN_DONE_KEY, "1");
      window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
      const lines: string[] = [];
      const logToFile = vi.fn(async (tag: string, message: string) => {
        if (tag === "first-run") lines.push(message);
        return ok(undefined);
      });
      const { platform, hasFeature } = adapter({ flag: true, logToFile, listImpl: () => new Promise(() => undefined) });
      await boot(platform);
      await settle(20);
      const routes = () => lines.filter((line) => line.startsWith("kind=route "));
      expect(routes().at(-1)).toContain("route=pending");
      expect(routes().at(-1)).toContain("finishedUnconfirmed=true");
      await vi.advanceTimersByTimeAsync(FIRST_RUN_LISTINGS_WAIT_MS + 100);
      await vi.waitFor(() => expect(routes().at(-1)).toContain("route=legacy"));
      expect(routes().at(-1)).toContain("finished=true finishedUnconfirmed=false");
      expect(window.localStorage.getItem(VISUAL_FIRST_RUN_DONE_KEY)).toBe("1");
      expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
      expect(hasFeature).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("visual first run: the found-apps flag is settled before the takeover opens", () => {
  it("holds the takeover until the found-apps answer, so the steps never swap mid-flow", async () => {
    let answerFoundApps: (value: unknown) => void = () => undefined;
    const hasFeatureImpl = vi.fn((name: string) =>
      name === VISUAL_FIRST_RUN_FLAG
        ? Promise.resolve(ok(true))
        : name === FIRST_RUN_FOUND_APPS_FLAG
          ? new Promise((resolve) => (answerFoundApps = resolve))
          : Promise.resolve(ok(false)),
    );
    const { platform } = adapter({ flag: true, hasFeatureImpl });
    await boot(platform);
    await settle(20);
    expect(hasFeatureImpl).toHaveBeenCalledWith(FIRST_RUN_FOUND_APPS_FLAG);
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    answerFoundApps(ok(false));
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    expect(step()).toBe("decision");
  });

  it("a found-apps answer that never comes holds the takeover for at most the first run's wait (counts as off)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const hasFeatureImpl = (name: string) =>
        name === VISUAL_FIRST_RUN_FLAG ? Promise.resolve(ok(true)) : name === FIRST_RUN_FOUND_APPS_FLAG ? new Promise(() => undefined) : Promise.resolve(ok(false));
      const { platform } = adapter({ flag: true, hasFeatureImpl });
      await boot(platform);
      await settle(20);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(FIRST_RUN_LISTINGS_WAIT_MS + 100);
      await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("visual first run: #welcome while the takeover waits for the bot listings", () => {
  // #1570 holds the takeover until the bot listings answer. #welcome showed
  // the old setup, with its start button, in that wait; a create made there
  // with #welcome's kickoff, then adopted by the takeover, would write twice.
  // #welcome now shows a loader until the takeover opens, so the old setup is
  // never on view and only the takeover creates: once, with no kickoff, and
  // one note at close.
  const listedSetupBot = {
    name: "setup",
    agentUid: SETUP_BOT_UID,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    pid: 1,
    processAlive: true,
    online: true,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/HQ/personal/workers/setup",
    workerId: "setup",
  };

  /**
   * `hq bot list` answers with whatever `rows` holds. With `holdAll`, every
   * call waits for `release`; otherwise only the first (the boot read the
   * takeover waits on) does.
   */
  function slowListing({ holdAll }: { holdAll: boolean }) {
    const rows: unknown[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    const listImpl = vi.fn(async () => {
      calls += 1;
      if (holdAll || calls === 1) await held;
      return ok({ bots: [...rows] });
    });
    return { rows, listImpl, release: () => release() };
  }

  const takeoverOpen = () => Boolean(q('[data-testid="first-run-takeover"]'));

  /** The route is visual and the takeover not yet open: #welcome shows the loader and no old setup. */
  async function expectWelcomeWaiting(log: ReturnType<typeof logSink>): Promise<void> {
    await settle(12);
    expect(takeoverOpen()).toBe(false);
    expect(log.of("route").at(-1)).toMatch(/^kind=route route=visual /);
    expect(q('[data-testid="welcome-route-pending"]')).toBeTruthy();
    expect(q('[data-testid="setup-run"]')).toBeNull();
    expect(q('[data-testid="setup-bot-fallback"]')).toBeNull();
  }

  async function walkTheTakeoverToDone(): Promise<void> {
    await vi.waitFor(() => expect(takeoverOpen()).toBe(true));
    await chooseBot();
    confirmName();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
  }

  function expectOneHandoffNote(sendDm: ReturnType<typeof vi.fn>): void {
    expect(sendDm).toHaveBeenCalledTimes(1);
    const [to, , extras] = sendDm.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(to).toBe(SETUP_BOT_UID);
    expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
  }

  async function walkCreatesOnceWithOneNote(holdAll: boolean): Promise<void> {
    const listing = slowListing({ holdAll });
    const openAtCreate: boolean[] = [];
    const create = vi.fn(async (_input: unknown) => {
      openAtCreate.push(takeoverOpen());
      listing.rows.push(listedSetupBot);
      return ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID });
    });
    const log = logSink();
    const { platform, sendDm } = adapter({
      create: create as never,
      flag: true,
      listImpl: listing.listImpl,
      logToFile: log.logToFile,
    });
    await boot(platform);
    await expectWelcomeWaiting(log);
    expect(create).not.toHaveBeenCalled();

    listing.release();
    await walkTheTakeoverToDone();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    await settle(12);
    expect(create).toHaveBeenCalledTimes(1);
    expect(openAtCreate).toEqual([true]);
    expect(create.mock.calls[0]![0]).not.toHaveProperty("kickoff");
    expectOneHandoffNote(sendDm);
  }

  it("with this computer's bot list slow, #welcome shows the loader until the takeover opens; one create, no kickoff, one note at close", async () => {
    await walkCreatesOnceWithOneNote(true);
  });

  it("with only the boot read slow, #welcome shows the loader until the takeover opens; one create, no kickoff, one note at close", async () => {
    await walkCreatesOnceWithOneNote(false);
  });
});

describe("visual first run: Bring in your context", () => {
  const IMPORTED = { summary: { companies: 0, projects: 0, sessions: 12 }, report: "workspace/reports/import.json" };

  /**
   * Boot with the flag on, run the scan (it starts by itself) to its end,
   * then name the assistant. Timers are fake from the scan on, so the notice
   * ledger's waits can be stepped through.
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
    // The scan starts by itself, with no question first.
    await vi.waitFor(() => expect(scanStart).toHaveBeenCalledTimes(1));
    expect(q('[data-testid="first-run-decision-question"]')).toBeNull();
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
    // The host's short tail wait: the import is recorded, and nothing is sent.
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    // The question shows once the scan is done; the bot is named there.
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await settle();
    return { sendDm, scanCancel };
  }

  /** Leave the takeover through Done ("Talk to Biscuit"). */
  async function talk(): Promise<void> {
    expect(step()).toBe("done");
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await settle();
  }

  function expectHandoffNotes(sendDm: ReturnType<typeof vi.fn>) {
    for (const call of sendDm.mock.calls) {
      const [to, body, extras] = call as unknown as [string, string, Record<string, unknown>];
      expect(to).toBe(SETUP_BOT_UID);
      expect(extras).toEqual({ audience: "agent", idempotencyKey: `first-run-handoff:${SETUP_BOT_UID}` });
      expect(body).toBe(
        firstRunHandoffNotice(
          {
            name: "Biscuit",
            runtime: "claude",
            toolsReady: ["claude"],
            signInChecked: false,
            imported: IMPORTED,
            team: null,
            apps: {},
          },
          { noun: "computer" },
        ),
      );
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a finished import for the one note at close, and tries a failed send again after the ledger's wait", async () => {
    const { sendDm, scanCancel } = await finishAScan(async () => failure("network", "offline"));
    // The scan finished while the takeover is open: nothing goes to the assistant.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(sendDm).not.toHaveBeenCalled();

    await talk();
    expect(sendDm).toHaveBeenCalledTimes(1);
    // Not before the notice ledger allows it (30 s after a failure that may pass).
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(11_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(2);
    expectHandoffNotes(sendDm);

    // Delivered: nothing more goes, however long it waits.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(2);
    expect(scanCancel).not.toHaveBeenCalled();
  });

  it("a send the server refuses (403) is not tried again, and says so in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendDm } = await finishAScan(async () => ({ ok: false, reason: "forbidden", code: "http-403" }));
    await talk();
    expect(sendDm).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await settle();
    expect(sendDm).toHaveBeenCalledTimes(1);
    expectHandoffNotes(sendDm);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not get the first-run handoff"));
    warn.mockRestore();
  });

  it("a pending try is called off when the shell goes away", async () => {
    const { sendDm } = await finishAScan(async () => failure("network", "offline"));
    await talk();
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
    while (create.mock.calls.length === 0 && elapsed < 8000) {
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

  it("a flag that answers before the setup-owed answer adds no wait; a slow one adds at most the owed wait", async () => {
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
    // Never answers: off once the wait past the owed answer runs out.
    // (Read in sequence, a 1200 ms flag would have started at 1700 ms.)
    const neverAnswers = await startTime({ hasFeatureImpl: flagAfter(null) });

    expect(answeredFirst).toBe(baseline);
    expect(baseline).toBeGreaterThanOrEqual(OWED_AT_MS);
    expect(answeredLater).toBeLessThanOrEqual(1200 + 50);
    expect(answeredLater).toBeLessThan(OWED_AT_MS + 1200);
    expect(neverAnswers).toBeGreaterThan(baseline);
    expect(neverAnswers).toBeGreaterThanOrEqual(OWED_AT_MS + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS);
    expect(neverAnswers).toBeLessThanOrEqual(baseline + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS + 50);
  });
});

describe("first-run route log (hq-sync.log)", () => {
  it("logs one line per route change, with what the route came from, and the flag read that answered", async () => {
    const log = logSink();
    const { platform } = adapter({ flag: true, logToFile: log.logToFile });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await settle();

    expect(log.of("route")).toEqual([
      "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      "kind=route route=visual flag=true owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
    ]);
    const flagLines = log.of("flag").map((line) => line.replace(/ elapsed_ms=\d+$/, ""));
    expect(flagLines).toEqual([
      "kind=flag flag=visual-first-run path=unscoped value=true applied=true",
      "kind=flag flag=found-apps path=unscoped value=false applied=true",
    ]);
    expect(log.of("setup-run")).toEqual([]);
  });

  it("says which caller set the setup-run record when the host reports setup as done", async () => {
    const log = logSink();
    const { platform } = adapter({
      flag: true,
      logToFile: log.logToFile,
      setupStatusImpl: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: false }),
    });
    await boot(platform);
    await vi.waitFor(() => expect(log.of("setup-run")).toEqual(["kind=setup-run event=set caller=mark-already-set-up"]));
    await settle();
    // The route went legacy the moment setup counted as run, before the flag answered.
    expect(log.of("route")).toEqual([
      "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      "kind=route route=legacy flag=null owed=false setupRun=true finished=false finishedUnconfirmed=false hasBots=true",
    ]);
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
  });

  describe("with a slow flag answer on a new install (fake timers)", () => {
    beforeEach(() => {
      // Date too: the late window is measured from the timeout with Date.now().
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const OWED_AT = 200;
    const delayed = <T,>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const owedAfter = (owed: boolean) => () =>
      delayed(OWED_AT, ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: owed }));
    /** `desktop.visual-first-run` answers on after `ms` (never with null); every other flag is off at once. */
    const flagOnAfter =
      (ms: number | null) =>
      (name: string): Promise<unknown> => {
        if (name !== VISUAL_FIRST_RUN_FLAG) return Promise.resolve(ok(false));
        return ms === null ? new Promise(() => {}) : delayed(ms, ok(true));
      };
    async function advance(until: number, from = 0): Promise<void> {
      for (let elapsed = from; elapsed < until; elapsed += 50) {
        await vi.advanceTimersByTimeAsync(50);
        await settle(4);
      }
    }
    const flagLines = (log: ReturnType<typeof logSink>) =>
      log.of("flag").map((line) => line.replace(/ elapsed_ms=\d+$/, ""));
    const legacyStart = (create: ReturnType<typeof vi.fn>) =>
      create.mock.calls.some((call) => (call[0] as { kickoff?: string } | undefined)?.kickoff === SETUP_BOT_KICKOFF);

    it("an on answer at 1.5 s, past the old 1 s grace, opens the takeover, and nothing old starts while it waits", async () => {
      const log = logSink();
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const { platform } = adapter({
        create,
        logToFile: log.logToFile,
        setupStatusImpl: owedAfter(true),
        hasFeatureImpl: flagOnAfter(1500),
      });
      await boot(platform);
      await advance(1400);
      // Still waiting: no takeover yet, and the old setup has not started.
      expect(log.of("route").at(-1)).toMatch(/^kind=route route=pending /);
      expect(legacyStart(create)).toBe(false);
      await advance(2400, 1400);

      expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
      expect(legacyStart(create)).toBe(false);
      expect(flagLines(log)[0]).toBe("kind=flag flag=visual-first-run path=unscoped value=true applied=true");
      expect(log.of("route")).toEqual([
        "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
        "kind=route route=visual flag=true owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      ]);
    });

    it("no answer within the wait: the old setup, logged as a timeout", async () => {
      const log = logSink();
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const { platform } = adapter({
        create,
        logToFile: log.logToFile,
        setupStatusImpl: owedAfter(true),
        hasFeatureImpl: flagOnAfter(null),
      });
      await boot(platform);
      await advance(OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS - 200);
      expect(log.of("route").at(-1)).toMatch(/^kind=route route=pending /);
      expect(legacyStart(create)).toBe(false);
      await advance(OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS + 600, OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS - 200);

      expect(flagLines(log)).toEqual(["kind=flag flag=visual-first-run path=timeout value=false applied=true"]);
      expect(log.of("route").at(-1)).toBe(
        "kind=route route=legacy flag=false owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      );
      expect(legacyStart(create)).toBe(true);
      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    });

    it("an on answer after the wait ran out, before anything old started, still opens the takeover", async () => {
      const log = logSink();
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const lateAt = OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS + 800;
      // No coding tool signed in: the old setup does not start by itself.
      const { platform } = adapter({
        create,
        claudeLoggedIn: false,
        probe: null,
        logToFile: log.logToFile,
        setupStatusImpl: owedAfter(true),
        hasFeatureImpl: flagOnAfter(lateAt),
      });
      await boot(platform);
      await advance(lateAt - 200);
      expect(log.of("route").at(-1)).toMatch(/^kind=route route=legacy /);
      await advance(lateAt + 1000, lateAt - 200);

      expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
      expect(create).not.toHaveBeenCalled();
      expect(flagLines(log).slice(0, 2)).toEqual([
        "kind=flag flag=visual-first-run path=timeout value=false applied=true",
        "kind=flag flag=visual-first-run path=unscoped value=true applied=true late=applied",
      ]);
      expect(log.of("route")).toEqual([
        "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
        "kind=route route=legacy flag=false owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
        "kind=route route=visual flag=true owed=true setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
      ]);
    });

    it("an on answer after the old setup already started keeps the old setup, and says so", async () => {
      const log = logSink();
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const lateAt = OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS + 800;
      const { platform } = adapter({
        create,
        logToFile: log.logToFile,
        setupStatusImpl: owedAfter(true),
        hasFeatureImpl: flagOnAfter(lateAt),
      });
      await boot(platform);
      await advance(lateAt - 200);
      expect(legacyStart(create)).toBe(true);
      await advance(lateAt + 1000, lateAt - 200);

      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      expect(flagLines(log)).toEqual([
        "kind=flag flag=visual-first-run path=timeout value=false applied=true",
        "kind=flag flag=visual-first-run path=unscoped value=true applied=false late=legacy-started",
      ]);
      expect(log.of("route").at(-1)).toMatch(/^kind=route route=legacy /);
    });

    describe("the late window and what counts as the old setup having started", () => {
      // The wait runs out at about OWED_AT + the owed wait; the late window is measured from then.
      const TIMED_OUT_AT = OWED_AT + VISUAL_FIRST_RUN_FLAG_OWED_WAIT_MS;
      const FIRST_LINE = "kind=flag flag=visual-first-run path=timeout value=false applied=true";
      // A row click moves the address; start each test from the app's own start.
      const startUrl = window.location.href;
      afterEach(() => window.history.replaceState(null, "", startUrl));

      /** No coding tool signed in, so nothing old starts by itself while the late answer is coming. */
      function lateOn(lateAt: number, extra: Partial<AdapterOptions> = {}) {
        const log = logSink();
        const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
        const { platform } = adapter({
          create,
          claudeLoggedIn: false,
          probe: null,
          logToFile: log.logToFile,
          setupStatusImpl: owedAfter(true),
          hasFeatureImpl: flagOnAfter(lateAt),
          ...extra,
        });
        return { log, create, platform };
      }
      /** The install is still running when the late answer lands, so nothing else has started the old setup yet. */
      function installGuide() {
        return {
          oninstall: vi.fn(() => new Promise<{ ok: boolean }>(() => undefined)),
          onsignin: vi.fn(async () => ({ ok: true })),
          onrefresh: vi.fn(async () => undefined),
          downloadUrlFor: () => "https://claude.com/download",
          onopen: vi.fn(() => undefined),
        };
      }
      /** A sidebar row other than #welcome. */
      function otherRow(): HTMLButtonElement {
        const row = [...document.querySelectorAll<HTMLButtonElement>("button[data-conversation-id]")].find(
          (button) => button.getAttribute("data-conversation-id") !== SETUP_ROW_ID,
        );
        expect(row, "a row other than #welcome").toBeTruthy();
        return row!;
      }
      function stayedLegacy(log: ReturnType<typeof logSink>, late: string): void {
        expect(q('[data-testid="first-run-takeover"]')).toBeNull();
        expect(flagLines(log).slice(0, 2)).toEqual([
          FIRST_LINE,
          `kind=flag flag=visual-first-run path=unscoped value=true applied=false late=${late}`,
        ]);
        expect(log.of("route").at(-1)).toMatch(/^kind=route route=legacy /);
      }

      it("an on answer inside the window with nothing touched still opens the takeover", async () => {
        const lateAt = TIMED_OUT_AT + VISUAL_FIRST_RUN_FLAG_LATE_WINDOW_MS - 500;
        const { log, create, platform } = lateOn(lateAt);
        await boot(platform);
        await advance(lateAt + 1000);

        expect(q('[data-testid="first-run-takeover"]')).toBeTruthy();
        expect(create).not.toHaveBeenCalled();
        expect(flagLines(log).slice(0, 2)).toEqual([
          FIRST_LINE,
          "kind=flag flag=visual-first-run path=unscoped value=true applied=true late=applied",
        ]);
      });

      it("#welcome shows the loader while the flag is pending, and the old setup once the wait runs out", async () => {
        const { log, platform } = lateOn(TIMED_OUT_AT + 8_000);
        await boot(platform);
        await advance(OWED_AT + 1_000);
        expect(log.of("route").at(-1)).toMatch(/^kind=route route=pending /);
        expect(q('[data-testid="welcome-route-pending"]')).toBeTruthy();
        expect(q('[data-testid="setup-bot-fallback"]')).toBeNull();

        await advance(TIMED_OUT_AT + 600, OWED_AT + 1_000);
        expect(log.of("route").at(-1)).toMatch(/^kind=route route=legacy /);
        expect(q('[data-testid="welcome-route-pending"]')).toBeNull();
        expect(q('[data-testid="setup-bot-fallback"]')).toBeTruthy();
      });

      it("an on answer 8 s after the wait ran out keeps the old setup, logged as too late", async () => {
        const lateAt = TIMED_OUT_AT + 8_000;
        const { log, platform } = lateOn(lateAt);
        await boot(platform);
        await advance(lateAt + 1000);

        stayedLegacy(log, "too-late");
      });

      it("an install-guide action in #welcome before the late on answer keeps the old setup", async () => {
        const lateAt = TIMED_OUT_AT + 2_000;
        const guide = installGuide();
        const { log, platform } = lateOn(lateAt);
        await boot(platform, DesktopApp, mount, { setupInstallGuide: guide });
        await advance(TIMED_OUT_AT + 600);
        q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.click();
        await settle();
        expect(guide.oninstall).toHaveBeenCalled();
        await advance(lateAt + 1000, TIMED_OUT_AT + 600);

        stayedLegacy(log, "legacy-started");
      });

      it("the step-by-step setup link in #welcome before the late on answer keeps the old setup", async () => {
        const lateAt = TIMED_OUT_AT + 2_000;
        const { log, platform } = lateOn(lateAt);
        await boot(platform);
        await advance(TIMED_OUT_AT + 600);
        q<HTMLButtonElement>('[data-testid="setup-bot-fallback"]')!.click();
        await settle();
        await advance(lateAt + 1000, TIMED_OUT_AT + 600);

        stayedLegacy(log, "legacy-started");
      });

      it("selecting another row before the late on answer keeps the old setup", async () => {
        const lateAt = TIMED_OUT_AT + 2_000;
        const { log, platform } = lateOn(lateAt);
        await boot(platform);
        await advance(TIMED_OUT_AT + 600);
        otherRow().click();
        await settle();
        await advance(lateAt + 1000, TIMED_OUT_AT + 600);

        stayedLegacy(log, "legacy-started");
      });

      it("a message sent before the late on answer keeps the old setup", async () => {
        const lateAt = TIMED_OUT_AT + 2_000;
        const { log, platform } = lateOn(lateAt);
        await boot(platform);
        await advance(TIMED_OUT_AT + 600);
        // #welcome has no composer, so the message goes from another row.
        otherRow().click();
        await settle();
        const composer = q<HTMLTextAreaElement>('[data-testid="conversation-composer"]')!;
        composer.value = "hello";
        composer.dispatchEvent(new Event("input", { bubbles: true }));
        await settle();
        q<HTMLButtonElement>('[data-testid="composer-send"]')!.click();
        await settle();
        await advance(lateAt + 1000, TIMED_OUT_AT + 600);

        stayedLegacy(log, "legacy-started");
      });

      it("something old starting after the late on answer, before the takeover opens, stops it opening", async () => {
        const lateAt = TIMED_OUT_AT + 2_000;
        // This computer's bot list answers 1.5 s after the flag, so the takeover is still waiting to open.
        const { log, create, platform } = lateOn(lateAt, {
          listImpl: () => delayed(lateAt + 1_500, ok({ bots: [] })),
        });
        await boot(platform);
        await advance(lateAt + 200);
        expect(flagLines(log)[1]).toBe(
          "kind=flag flag=visual-first-run path=unscoped value=true applied=true late=applied",
        );
        expect(q('[data-testid="first-run-takeover"]')).toBeNull();
        otherRow().click();
        await settle();
        await advance(lateAt + 1_500 + FIRST_RUN_LISTINGS_WAIT_MS + 1000, lateAt + 200);

        expect(q('[data-testid="first-run-takeover"]')).toBeNull();
        expect(create).not.toHaveBeenCalled();
        expect(log.of("route").at(-1)).toMatch(/^kind=route route=legacy /);
      });
    });

    it("setup not owed: unchanged, the old route at once and a later on answer is not applied", async () => {
      const log = logSink();
      const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
      const { platform } = adapter({
        create,
        logToFile: log.logToFile,
        setupStatusImpl: owedAfter(false),
        hasFeatureImpl: flagOnAfter(1500),
      });
      await boot(platform);
      await advance(2500);

      expect(q('[data-testid="first-run-takeover"]')).toBeNull();
      expect(log.of("route")).toEqual([
        "kind=route route=pending flag=null owed=null setupRun=false finished=false finishedUnconfirmed=false hasBots=true",
        "kind=route route=legacy flag=null owed=false setupRun=true finished=false finishedUnconfirmed=false hasBots=true",
      ]);
      // The short grace still applies when setup is not owed, and the late on is dropped as before.
      expect(flagLines(log)).toEqual([
        "kind=flag flag=visual-first-run path=timeout value=false applied=true",
        "kind=flag flag=visual-first-run path=unscoped value=true applied=false",
      ]);
    });
  });
});

describe("first-run conversation start with a slow create", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts the conversation when the name is confirmed, so an intro written more than the grace before the adopt still shows", async () => {
    const confirmedAt = Date.parse("2026-10-15T16:00:00.000Z");
    let now = confirmedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let finishCreate: (() => void) | null = null;
    const create = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finishCreate = () => resolve(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
        }),
    ) as unknown as NonNullable<PlatformAdapter["bots"]>["create"];
    const { platform } = adapter({ create, flag: true });
    await boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    // `hq bot create --intro` writes the intro a second in, then takes 45 s more.
    const intro = { eventId: "intro", createdAt: new Date(confirmedAt + 1_000).toISOString() };
    now = confirmedAt + 1_000 + CONVERSATION_START_GRACE_MS + 15_000;
    finishCreate!();
    await settle();

    const starts = readConversationStarts(window.localStorage);
    expect(starts[SETUP_BOT_UID]).toBe(confirmedAt);
    expect(fromConversationStart([intro], starts, SETUP_BOT_UID)).toEqual([intro]);
  });
});
