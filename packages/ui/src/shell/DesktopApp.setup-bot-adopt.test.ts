// @vitest-environment happy-dom

/**
 * ADOPT, NEVER RE-CREATE (desktop UX feedback, round 4).
 *
 * The owner wiped this Mac's HQ state but kept the same HQ Cloud account — a
 * reinstall, or setting HQ up on a second Mac. `hq bot list` only knows THIS
 * Mac, so the local guard passed, `hq bot create setup` ran, and the cloud
 * (which still owns the agent entity) answered 409. Two things went wrong at
 * once, and both are covered here:
 *
 *   - the start path created instead of adopting, and a race let it create
 *     TWICE (the VM's hq-sync.log shows two creates 1.3 s apart);
 *   - the failure was rendered verbatim — `HQ API /v1/agents → 409: Entity
 *     with type="agent" and slug="setup-rg13gzm4" already exists`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";

/** What the cloud says when this account already owns a setup bot. */
const API_409 =
  'HQ API /v1/agents → 409: Entity with type="agent" and slug="setup-rg13gzm4" already exists';
const CLOUD_SETUP_UID = "agt_cloud_setup";

function setupBotRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: CLOUD_SETUP_UID,
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
  /** The account's DM roster, i.e. what the CLOUD knows about. */
  contacts?: Array<Record<string, unknown>>;
}

function adapter({ bots = {}, contacts = [] }: AdapterOptions = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
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
          claudeLoggedIn: true,
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
    },
    bots: {
      list: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true, name: "setup", agentUid: "agt_new" }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      ...bots,
    },
  } as unknown as PlatformAdapter;
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

function mountApp(platform: PlatformAdapter): void {
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
}

/** Land on #welcome without letting the automatic start run first. */
async function openWelcomeAfterSetupRan(platform: PlatformAdapter): Promise<void> {
  window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
  mountApp(platform);
  await settle();
  const row = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
  expect(row, "pinned #welcome row renders").toBeTruthy();
  row!.click();
  await settle();
}

/** Every reason string this shell can put on screen right now. */
function renderedReasons(): string[] {
  return [
    ...host.querySelectorAll('[data-testid="setup-bot-error"]'),
    ...host.querySelectorAll('[data-testid="setup-card-bot-error"]'),
    ...host.querySelectorAll('[data-testid="bot-progress-card"]'),
    ...host.querySelectorAll('[role="alert"]'),
  ].map((el) => el.textContent ?? "");
}

describe("the setup bot this account already owns is adopted, never re-created", () => {
  it("a setup bot that exists only in the cloud is opened, with no create at all", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: "agt_new" }));
    // `hq bot list` is empty (local state was wiped); the cloud roster still
    // carries the agent this account owns.
    mountApp(
      adapter({
        bots: { create, list: async () => ok({ bots: [] }) },
        contacts: [
          { personUid: "prs_mate", displayName: "Sam", companyUid: "cmp_1" },
          { personUid: CLOUD_SETUP_UID, displayName: "setup", companyUid: null },
        ],
      }),
    );

    // The automatic first-open start runs; it must adopt, not create.
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    expect(create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
    await settle(20);
    expect(create).not.toHaveBeenCalled();
  });

  it("a create that comes back 409 adopts the bot and shows the person nothing at all", async () => {
    // The roster has not caught up when the create is attempted, so the race
    // is only discoverable from the 409; `hq bot list` sees the bot right
    // after (the cloud entity is now reconciled locally).
    let listed: LocalBotRow[] = [];
    const create = vi.fn(async () => {
      listed = [setupBotRow()];
      return { ok: false as const, reason: "unavailable" as const, message: API_409 };
    });
    mountApp(adapter({ bots: { create, list: async () => ok({ bots: listed }) } }));

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    // Adopted: the bot's DM is open and setup counts as run.
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBe("1");
    // And nothing was reported as a failure.
    expect(q('[data-testid="setup-bot-error"]')).toBeNull();
    expect(q('[data-testid="setup-bot-retry"]')).toBeNull();
  });

  it("no raw API text ever reaches the screen, whatever the failure", async () => {
    // Nothing anywhere can adopt this one, so the recovery UI does render —
    // and it still must not quote the API.
    const create = vi.fn(async () => ({
      ok: false as const,
      reason: "unavailable" as const,
      message: API_409,
    }));
    await openWelcomeAfterSetupRan(adapter({ bots: { create } }));

    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="setup-bot-error"]')).toBeTruthy());

    const shown = renderedReasons().join(" ");
    expect(shown).not.toContain("HQ API");
    expect(shown).not.toContain("409");
    expect(shown).not.toContain("/v1/agents");
    expect(shown).not.toContain("slug=");
    expect(shown).not.toMatch(/\b\d{3}\b/);
    // It says the true thing instead.
    expect(q('[data-testid="setup-bot-error"]')?.textContent).toContain("already has a setup bot");
    // The whole document, not just the reason nodes.
    expect(host.textContent ?? "").not.toContain("HQ API");
  });

  /**
   * The host's start is gated by `singleFlightStart` (unit-tested in
   * setup-bot.test.ts: a caller arriving mid-start gets the running start's
   * own result). This is the shell half of that guarantee — while a start is
   * running, #welcome cannot begin a second one.
   */
  it("while the bot is being made, #welcome cannot start a second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listed: LocalBotRow[] = [];
    const create = vi.fn(async () => {
      await gate;
      listed = [setupBotRow({ agentUid: "agt_new" })];
      return ok({ ok: true, name: "setup", agentUid: "agt_new" });
    });
    // The automatic first-open start is in flight when the person, seeing
    // nothing happen yet, presses Run Setup.
    mountApp(adapter({ bots: { create: create as never, list: async () => ok({ bots: listed }) } }));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    const run = q<HTMLButtonElement>('[data-testid="setup-run"]');
    expect(run, "#welcome still shows the start button while the bot is being made").toBeTruthy();
    expect(run!.disabled, "the button says what is happening instead of firing again").toBe(true);
    run!.click();
    run!.click();
    await settle(20);
    expect(create).toHaveBeenCalledOnce();

    release();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    expect(create).toHaveBeenCalledOnce();
  });
});
