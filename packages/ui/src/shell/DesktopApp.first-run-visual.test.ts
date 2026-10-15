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
import { WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { SETUP_BOT_KICKOFF, SETUP_BOT_NAMES, setupBotIntro } from "../chat/setup-bot.js";
import {
  VISUAL_FIRST_RUN_DONE_KEY,
  VISUAL_FIRST_RUN_FLAG_GRACE_MS,
  FIRST_RUN_LISTINGS_WAIT_MS,
  firstRunHandoffNotice,
  firstRunIntro,
} from "../chat/first-run/visual-first-run.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

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
  /** The app's active company slug (the brief job names it); absent leaves the host without `appShell`. */
  activeCompany?: string;
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
  activeCompany,
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
    ...(activeCompany
      ? {
          appShell: {
            getActiveCompany: async () => ok(activeCompany),
            showOsNotification: async () => ok(undefined),
          },
          files: { getFileContent: async () => ({ ok: false as const, reason: "not found" }) },
        }
      : {}),
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
      ...extraProps,
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
    // The welcome report is open, the takeover is gone for good.
    expect(q('[data-testid="first-run-takeover"]')).toBeNull();
    await vi.waitFor(() => expect(q('[data-testid="welcome-report"]')).toBeTruthy());
    expect(q('[data-testid="setup-hero"]')).toBeNull();
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

  it("Continue in the coding tool lands on the welcome report, starts nothing by itself, and the takeover never opens again", async () => {
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
    await vi.waitFor(() => expect(q('[data-testid="welcome-report"]')).toBeTruthy());
    expect(q('[data-testid="setup-hero"]')).toBeNull();
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

describe("welcome report (US-009)", () => {
  const runningSetupBot = {
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
  const briefJobs = (sendDm: ReturnType<typeof vi.fn>) =>
    (sendDm.mock.calls as unknown as [string, string][]).filter(([, body]) => body.startsWith("/daily-brief "));

  it("the coding tool path shows the loading card in the brief view, never the bare shell or #welcome", async () => {
    const { platform } = adapter({ flag: true });
    await boot(platform);
    await decisionShown();
    q<HTMLButtonElement>('[data-testid="first-run-decision-primary"]')!.click();
    await settle();
    await vi.waitFor(() => expect(q('[data-testid="welcome-report-loading"]')).toBeTruthy());
    expect(q('[data-testid="welcome-report-loading"]')?.textContent).toContain("Your welcome report is loading");
    expect(q('[data-testid="welcome-report-loading"] [role="progressbar"]')).not.toBeNull();
    expect(q('[data-testid="setup-hero"]')).toBeNull();
  });

  it("sends the brief job to the assistant once, only after it appears", async () => {
    let created = false;
    const create = vi.fn(async () => {
      created = true;
      return ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID });
    });
    const listImpl = async () => ok({ bots: created ? [runningSetupBot] : [] });
    const { platform, sendDm } = adapter({ create, flag: true, listImpl, activeCompany: "indigo" });
    await boot(platform);
    await chooseBot();
    typeName("Biscuit");
    confirmName();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await settle(12);
    // Nothing for the report before the person leaves the takeover.
    expect(briefJobs(sendDm)).toHaveLength(0);

    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(briefJobs(sendDm)).toHaveLength(1));
    const [to, body] = briefJobs(sendDm)[0]!;
    expect(to).toBe(SETUP_BOT_UID);
    expect(body.startsWith("/daily-brief indigo --run-id")).toBe(true);
    expect(q('[data-testid="welcome-report-loading"]')).not.toBeNull();
    await settle(30);
    expect(briefJobs(sendDm)).toHaveLength(1);
  });

  /** A host whose scan finds Linear, with one company to connect it to. */
  async function bootWithApps(foundApps: boolean): Promise<void> {
    const hasFeatureImpl = async (name: string) =>
      ok(name === VISUAL_FIRST_RUN_FLAG ? true : name === FIRST_RUN_FOUND_APPS_FLAG ? foundApps : false);
    const { platform } = adapter({ flag: true, hasFeatureImpl });
    const raw = platform as unknown as Record<string, Record<string, unknown>>;
    raw.shell = {
      ...raw.shell,
      detectWorkApps: async () =>
        ok({ platform: "macos", scannedAtMs: 1, apps: [{ bundleId: "com.linear", name: "Linear" }], mcpServers: [], sources: [], truncated: false }),
    };
    raw.integrations = {
      catalogLookup: async () => ok({ entries: [] }),
      listConnections: async () => ok({ connections: [] }),
    };
    const workspace = {
      slug: "northwind",
      displayName: "Northwind",
      kind: "company",
      state: "synced",
      cloudUid: "cmp_northwind",
      bucketName: "hq-northwind",
      hasLocalFolder: true,
      localPath: "/tmp/hq-folder/northwind",
      membershipStatus: "active",
      role: "owner",
      lastSyncedAt: null,
      brokenReason: null,
      invitedBy: null,
      invitedAt: null,
    };
    await boot(platform, DesktopApp, mount, { companies: [workspace], rosterStatus: "ready" });
    await decisionShown();
    q<HTMLButtonElement>('[data-testid="first-run-decision-primary"]')!.click();
    await settle();
    await vi.waitFor(() => expect(q('[data-testid="welcome-report"]')).toBeTruthy());
  }

  it("found-apps flag on: the connect card offers the apps the scan found", async () => {
    await bootWithApps(true);
    await vi.waitFor(() =>
      expect(q('[data-testid="welcome-connect-card"] [data-testid="first-run-app-linear.app"]')).toBeTruthy(),
    );
  });

  it("found-apps flag off: the welcome report has no connect card", async () => {
    await bootWithApps(false);
    await settle(20);
    expect(q('[data-testid="welcome-connect-card"]')).toBeNull();
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

describe("visual first run: #welcome's start while the takeover waits for the bot listings", () => {
  // #1570 holds the takeover until the bot listings answer, and #welcome's
  // start button is live in that wait. A create made there with #welcome's
  // kickoff, then adopted by the takeover, would write twice: once on create
  // and once on the note at close. The start reads the listings itself before
  // it creates, which ends the wait first; these pin that order.
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

  async function clickWelcomeStartInTheWait(): Promise<void> {
    await settle(12);
    expect(takeoverOpen()).toBe(false);
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="setup-run"]')?.disabled).toBe(false));
    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
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

  it("with this computer's bot list slow, the click creates nothing until the takeover is open; no kickoff, one note at close", async () => {
    const listing = slowListing({ holdAll: true });
    const openAtCreate: boolean[] = [];
    let landCreate!: (value: unknown) => void;
    const create = vi.fn((_input: unknown) => {
      openAtCreate.push(takeoverOpen());
      return new Promise((r) => (landCreate = r));
    });
    const { platform, sendDm } = adapter({ create: create as never, flag: true, listImpl: listing.listImpl });
    await boot(platform);
    await clickWelcomeStartInTheWait();
    await settle(12);
    expect(create).not.toHaveBeenCalled();

    listing.release();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(openAtCreate).toEqual([true]);
    expect(create.mock.calls[0]![0]).not.toHaveProperty("kickoff");
    listing.rows.push(listedSetupBot);
    landCreate(ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();

    await walkTheTakeoverToDone();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    await settle(12);
    expect(create).toHaveBeenCalledTimes(1);
    expectOneHandoffNote(sendDm);
  });

  it("with only the boot read slow, the click's own read opens the takeover before it creates; no kickoff, one note at close", async () => {
    const listing = slowListing({ holdAll: false });
    const openAtCreate: boolean[] = [];
    const create = vi.fn(async (_input: unknown) => {
      openAtCreate.push(takeoverOpen());
      listing.rows.push(listedSetupBot);
      return ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID });
    });
    const { platform, sendDm } = adapter({ create: create as never, flag: true, listImpl: listing.listImpl });
    await boot(platform);
    await clickWelcomeStartInTheWait();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(openAtCreate).toEqual([true]);
    expect(create.mock.calls[0]![0]).not.toHaveProperty("kickoff");
    await settle(12);
    expect(sendDm).not.toHaveBeenCalled();

    listing.release();
    await walkTheTakeoverToDone();
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    await settle(12);
    expect(create).toHaveBeenCalledTimes(1);
    expectOneHandoffNote(sendDm);
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
