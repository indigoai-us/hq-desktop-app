// @vitest-environment happy-dom

/**
 * THE ASSISTANT HAS ONE OWNER (architecture review 2026-10-11).
 *
 * The v0.11.4 release check failed at step 5: the first run's create of
 * "Hazel" raced the app's automatic `hq bot restore`, which adopted the setup
 * bot a second earlier. The create failed with "already set up on this
 * computer", the takeover said "Couldn't start Hazel" next to a running bot,
 * the bot came up as yesterday's "Popcorn", and the status lines read "setup
 * is back online." and "setup is thinking…".
 *
 * These tests drive the real shell with the platform adapter mocked at the
 * CLI boundary, and assert what the person sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type LocalBotRow, type PlatformAdapter, type RemoteBotRow } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { takePendingChannelOpen, takePendingDmRequests } from "../chat/open-target.js";
import { AUTO_RESTORE_RETRY_MS } from "../chat/bot-auto-restore.js";
import { BOT_LIVE_ELSEWHERE_NOTICE } from "../chat/bot-restore.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import type { SetupRunApi, SetupRunSnapshot } from "../chat/setup-run.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

function dmRow(uid: string, title: string): ConversationRow {
  return { id: `dm:${uid}`, kind: "dm", title, personUid: uid } as ConversationRow;
}

const ASSISTANT_UID = "agt_assistant";
const OLD_HEARTBEAT = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
/** What hq-cli's adopt guard says when another writer brought the bot here first. */
const ALREADY_HERE =
  'Bot "setup" is already set up on this computer (/Users/admin/.hq/bots/setup). Start it with: hq bot start setup';

function localRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
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
    ...over,
  };
}

function remoteRow(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "setup",
    agentUid: ASSISTANT_UID,
    kind: "personal",
    online: false,
    lastHeartbeatAt: OLD_HEARTBEAT,
    here: false,
    settings: "claude, synced memory",
    ...over,
  };
}

interface Options {
  flag?: boolean;
  list?: () => LocalBotRow[];
  remote?: () => RemoteBotRow[];
  contacts?: Array<Record<string, unknown>>;
  create?: (input: Record<string, unknown>) => Promise<unknown>;
  restore?: () => Promise<unknown>;
  adopt?: (name: string) => Promise<unknown>;
  messages?: Array<Record<string, unknown>>;
  /** The installed hq-cli version (`getVersions().cli`); absent reads as unknown. */
  cliVersion?: string;
}

function adapter(opts: Options = {}) {
  const updateAgentProfile = vi.fn(async () => ok({}));
  const sendDm = vi.fn(async () => ok({ eventId: "evt_sent", createdAt: new Date().toISOString() }));
  const create = vi.fn(opts.create ?? (async () => ok({ ok: true, name: "setup", agentUid: ASSISTANT_UID })));
  const restore = vi.fn(opts.restore ?? (async () => ok({ ok: true, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 0, bots: [] })));
  const adopt = vi.fn(opts.adopt ?? (async () => ok({ ok: true })));
  const platform = {
    ...(opts.cliVersion ? { updates: { getVersions: async () => ok({ cli: opts.cliVersion }) } } : {}),
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    identity: {
      hasFeature: async (name: string) => ok(name === VISUAL_FIRST_RUN_FLAG ? Boolean(opts.flag) : false),
      updateAgentProfile,
    },
    messaging: {
      listContacts: async () => ok({ contacts: opts.contacts ?? [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: opts.messages ?? [], nextCursor: null }),
      sendDm,
      fetchReactions: async () => ok({ reactions: [] }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () =>
        ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ", welcomeSetupOwed: true }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
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
      list: async () => ok({ bots: opts.list ? opts.list() : [] }),
      listRemote: async () => ok({ bots: opts.remote ? opts.remote() : [] }),
      create,
      restore,
      adopt,
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      probe: async () => ok({ ok: true, class: null }),
    },
  } as unknown as PlatformAdapter;
  return { platform, create, restore, adopt, updateAgentProfile, sendDm };
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
  takePendingChannelOpen();
  takePendingDmRequests();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="first-run-takeover"]').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function boot(platform: PlatformAdapter, initialRow?: ConversationRow): void {
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
      ...(initialRow ? { initialRow } : {}),
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

/** Name the assistant on the takeover's name step and go on to Done. */
async function nameAssistant(name: string): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="first-run-takeover"]')).toBeTruthy());
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
  await settle();
}

/** Everything a person can read on screen. */
function screenText(): string {
  return document.body.textContent ?? "";
}

/**
 * The slug guard. The assistant's handle `setup` and its cloud slug never
 * reach a person-facing string: no element reads exactly "setup", and no
 * sentence uses it as a name ("setup is thinking", "setup is back online",
 * "setup and …", "setup: …").
 */
function expectNoSlug(where: string): void {
  const text = screenText();
  expect(text, `${where}: a sentence names the handle`).not.toMatch(/\bsetup (?:is|are|and|couldn't)\b/i);
  expect(text, `${where}: the cloud slug`).not.toMatch(/\bsetup-[a-z0-9]{6,12}\b/i);
  expect(text, `${where}: a status line names the handle`).not.toMatch(/\bsetup:/i);
  const exact = [...document.querySelectorAll("body *")].filter(
    (el) => el.children.length === 0 && (el.textContent ?? "").trim().toLowerCase() === "setup",
  );
  expect(exact.map((el) => el.outerHTML.slice(0, 120)), `${where}: an element shows the handle`).toEqual([]);
}

describe("first-run create racing automatic restore", () => {
  it("has exactly one outcome: one create, no restore of the assistant, the chosen name, no error", async () => {
    // The account owns yesterday's assistant ("Popcorn") in the cloud and a
    // second bot; this computer has neither (the release check's VM).
    let here: LocalBotRow[] = [];
    const { platform, create, restore, adopt, updateAgentProfile } = adapter({
      flag: true,
      list: () => here,
      remote: () => [
        remoteRow({ here: here.some((r) => r.name === "setup") }),
        remoteRow({ name: "test-bot", agentUid: "agt_test", here: here.some((r) => r.name === "test-bot") }),
      ],
      // An older hq-cli: create adopts the cloud assistant and keeps its old
      // name; a second writer would have been refused "already set up".
      create: async () => {
        if (here.some((r) => r.name === "setup")) return { ok: false, reason: "unavailable", message: ALREADY_HERE };
        here = [...here, localRow({ displayName: "Popcorn" })];
        return ok({ ok: true, name: "setup", agentUid: ASSISTANT_UID });
      },
      restore: async () => {
        // The racer: a bulk restore would take the assistant too.
        here = [...here, localRow({ displayName: "Popcorn" })];
        return ok({ ok: true, dryRun: false, restored: 1, repaired: 0, skipped: 0, failed: 0, bots: [{ name: "setup", agentUid: ASSISTANT_UID, action: "restored", detail: "" }] });
      },
      adopt: async (name: string) => {
        if (name === "test-bot") here = [...here, localRow({ name: "test-bot", agentUid: "agt_test" })];
        return ok({ ok: true });
      },
    });
    boot(platform);
    await nameAssistant("Hazel");

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    // The other bot still comes back by itself, on its own.
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledWith("test-bot"));
    await settle(30);

    // Exactly one outcome.
    expect(create).toHaveBeenCalledTimes(1);
    expect(restore, "the bulk restore would take the assistant").not.toHaveBeenCalled();
    expect(adopt.mock.calls.map((call) => call[0])).not.toContain("setup");
    // The chosen name, and no error anywhere.
    expect(q('[data-testid="first-run-talk"]')?.textContent).toContain("Talk to Hazel");
    expect(screenText()).not.toMatch(/couldn't start/i);
    expect(screenText()).not.toContain("Popcorn");
    // An older hq-cli kept yesterday's name: the app puts the chosen one on the profile.
    expect(updateAgentProfile).toHaveBeenCalledWith(ASSISTANT_UID, expect.objectContaining({ displayName: "Hazel" }));
    // A brand-new assistant is never "back online" (finding 5).
    expect(screenText()).not.toMatch(/hazel is back online/i);
    expectNoSlug("takeover");
    // The restore prompt never offers the assistant the first run is making.
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();

    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Hazel"));
    expect(screenText()).not.toMatch(/couldn't start/i);
    expectNoSlug("the assistant's conversation");
  });

  it("a create refused because the assistant arrived first ends ready, named, with no error", async () => {
    // Whatever brought it (a person's Restore, another window), the old CLI's
    // create answers "already set up on this computer".
    let here: LocalBotRow[] = [];
    const { platform, create, updateAgentProfile } = adapter({
      flag: true,
      list: () => here,
      create: async () => {
        here = [localRow({ displayName: "Popcorn" })];
        return { ok: false, reason: "unavailable", message: ALREADY_HERE };
      },
    });
    boot(platform);
    await nameAssistant("Hazel");
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    expect(create).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="first-run-talk"]')?.textContent).toContain("Talk to Hazel");
    expect(screenText()).not.toMatch(/couldn't start/i);
    expect(updateAgentProfile).toHaveBeenCalledWith(ASSISTANT_UID, { displayName: "Hazel" });
    expectNoSlug("takeover");
  });

  it("remembers the chosen name once for one create (finding 6)", async () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    let here: LocalBotRow[] = [];
    const { platform, create } = adapter({
      flag: true,
      list: () => here,
      create: async () => {
        here = [localRow()];
        return ok({ ok: true, name: "setup", agentUid: ASSISTANT_UID });
      },
    });
    boot(platform);
    await nameAssistant("Hazel");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await settle(20);
    const writes = setItem.mock.calls.filter(([key]) => key === "hq.bot-display-names.v1");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]![1] as string)).toEqual({ [ASSISTANT_UID]: "Hazel" });
  });
});

describe("no slug reaches a person-facing string (finding 3)", () => {
  it("the sidebar, the conversation title, is thinking, message authors and restore lines name the assistant", async () => {
    // An assistant created before names existed: its handle, its cloud name
    // and its own config all say "setup".
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    let scoutHere = false;
    const { platform, restore } = adapter({
      list: () => [
        localRow({ displayName: "setup" }),
        ...(scoutHere ? [localRow({ name: "scout", agentUid: "agt_scout", displayName: "Scout" })] : []),
      ],
      remote: () => [
        remoteRow({ here: true, online: true, lastHeartbeatAt: new Date().toISOString() }),
        { ...remoteRow({ name: "scout", agentUid: "agt_scout", here: scoutHere }), displayName: "Scout" },
      ],
      contacts: [{ personUid: ASSISTANT_UID, displayName: "setup", companyUid: null }],
      messages: [
        {
          eventId: "evt_hello",
          body: "Hi, I'm your setup bot.",
          fromPersonUid: ASSISTANT_UID,
          fromDisplayName: "setup",
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          direction: "in",
        },
      ],
      restore: async () => {
        scoutHere = true;
        return ok({
          ok: true,
          dryRun: false,
          restored: 1,
          repaired: 0,
          skipped: 0,
          failed: 0,
          bots: [{ name: "scout", agentUid: "agt_scout", action: "restored", detail: "", displayName: "Scout" }],
        });
      },
    });
    boot(platform, dmRow(ASSISTANT_UID, "setup"));

    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Your assistant"));
    // The other bot came back by itself, by its name.
    await vi.waitFor(() => expect(restore).toHaveBeenCalled());
    await vi.waitFor(() => expect(screenText()).toContain("Scout is back online."));

    // The person writes; the assistant is thinking, by its name.
    const composer = q<HTMLTextAreaElement>('[data-testid="conversation-composer"]')!;
    composer.value = "hi";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(q('[data-testid="agent-thinking-row"]')?.textContent).toContain("Your assistant is thinking"),
    );
    // The assistant's DM row in the sidebar reads its name too.
    const rowEl = q(`[data-conversation-id="dm:${ASSISTANT_UID}"]`);
    if (rowEl) expect(rowEl.textContent).toContain("Your assistant");
    expectNoSlug("the assistant's conversation");
  });

  it("an assistant with a name is called by it everywhere, not by yesterday's config", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    window.localStorage.setItem("hq.bot-display-names.v1", JSON.stringify({ [ASSISTANT_UID]: "Hazel" }));
    const { platform } = adapter({
      // An older hq-cli reports its own config file: yesterday's name.
      list: () => [localRow({ displayName: "Popcorn" })],
      contacts: [{ personUid: ASSISTANT_UID, displayName: "setup", companyUid: null }],
    });
    boot(platform, dmRow(ASSISTANT_UID, "setup"));
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Hazel"));
    await settle(20);
    expect(screenText()).not.toContain("Popcorn");
    expectNoSlug("the assistant's conversation");
  });
});

describe("Couldn't start never shows while the assistant is here (finding 4)", () => {
  it("a failed start's sentence goes away the moment the bot list shows the assistant", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    let here: LocalBotRow[] = [];
    const { platform, create } = adapter({
      list: () => here,
      create: async () => ({ ok: false, reason: "unavailable", message: "Could not reach HQ Cloud." }),
    });
    boot(platform);
    await settle(20);
    const welcome = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
      expect(el).toBeTruthy();
      return el!;
    });
    welcome.click();
    await settle(20);
    q<HTMLButtonElement>('[data-testid="setup-run"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q('[data-testid="setup-bot-error"]')).toBeTruthy());

    // Something else brings the assistant up (a restore from another
    // surface, a CLI run by hand). The next listing shows it running.
    here = [localRow()];
    await vi.advanceTimersByTimeAsync(40_000);
    await settle(20);
    await vi.waitFor(() => expect(q('[data-testid="setup-bot-error"]')).toBeNull());
    expect(screenText()).not.toMatch(/couldn't start|could not reach/i);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("the owner never takes an assistant running on another computer (review fix 1)", () => {
  it("#welcome's automatic start, flag off, empty roster: opens it with the honest notice, adopts and creates nothing", async () => {
    const { platform, create, adopt } = adapter({
      flag: false,
      list: () => [],
      contacts: [],
      remote: () => [remoteRow({ online: true, lastHeartbeatAt: new Date().toISOString() })],
    });
    boot(platform);
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Your assistant"));
    await vi.waitFor(() =>
      expect(q('[data-testid="bot-not-runnable-notice"]')?.textContent).toContain(BOT_LIVE_ELSEWHERE_NOTICE),
    );
    await settle(30);
    expect(adopt).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("recovering the assistant after setup ran here (review fix 2)", () => {
  it("tries again after the back-off, within the budget, and only then offers the Restore prompt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const { platform, adopt } = adapter({
      list: () => [],
      remote: () => [remoteRow()],
      adopt: async () => ({ ok: false, reason: "error", message: "HQ API /v1/agents/x/credentials → 500" }),
    });
    boot(platform);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    await settle(20);
    // Waiting out its back-off: the app is still handling it, so no prompt.
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTO_RESTORE_RETRY_MS + 1_000);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(AUTO_RESTORE_RETRY_MS + 1_000);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(3));
    // Out of budget: the person's own way back is offered, and nothing more is tried.
    await vi.waitFor(() => expect(q('[data-testid="bot-restore-banner"]')).toBeTruthy());
    await vi.advanceTimersByTimeAsync(AUTO_RESTORE_RETRY_MS * 3);
    await settle(20);
    expect(adopt).toHaveBeenCalledTimes(3);
    expect(adopt.mock.calls.every((call) => call[0] === "setup")).toBe(true);
  });
});

describe("the progress card's Retry goes through the owner (review fix 4)", () => {
  it("a Retry whose create finds the assistant already here ends quietly, with no failure and no handle", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let here: LocalBotRow[] = [];
    let creates = 0;
    const { platform, create } = adapter({
      flag: false,
      list: () => here,
      create: async () => {
        creates += 1;
        if (creates === 1) return ok({ ok: true, name: "setup", agentUid: ASSISTANT_UID });
        // The second time, another writer already brought it here.
        here = [...here, localRow({ state: "running", online: true })];
        return { ok: false, reason: "unavailable", message: ALREADY_HERE };
      },
    });
    boot(platform);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q('[data-testid="bot-progress-card"]')).toBeTruthy());
    // It never comes online: the card gives up and offers Retry (at the next
    // listing after its time is up; another bot turning up is that listing).
    await vi.advanceTimersByTimeAsync(181_000);
    here = [localRow({ name: "scout", agentUid: "agt_scout", displayName: "Scout" })];
    await vi.advanceTimersByTimeAsync(40_000);
    const retry = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="bot-progress-retry"]');
      expect(el).toBeTruthy();
      return el!;
    });
    retry.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    await settle(30);
    expect(screenText()).not.toMatch(/could not create|couldn't start/i);
    expectNoSlug("the assistant's conversation after Retry");
  });
});

describe("round 2 review items", () => {
  it("an assistant brought back as it is (hq bot adopt) gets the handoff note when the first run settles on it (4)", async () => {
    // An older CLI on a computer whose account owns yesterday's assistant: the
    // listing shows it, the person confirms a name, and the create adopts it.
    let here: LocalBotRow[] = [];
    const { platform, sendDm } = adapter({
      flag: true,
      list: () => here,
      create: async () => {
        here = [localRow({ displayName: "Popcorn" })];
        return { ok: false, reason: "unavailable", message: ALREADY_HERE };
      },
    });
    boot(platform);
    await nameAssistant("Hazel");
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalled());
    const [to, , opts] = (sendDm.mock.calls as unknown as Array<[string, string, { idempotencyKey?: string }]>)[0]!;
    expect(to).toBe(ASSISTANT_UID);
    expect(opts.idempotencyKey).toBe(`first-run-handoff:${ASSISTANT_UID}`);
    q<HTMLButtonElement>('[data-testid="first-run-talk"]')!.click();
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Hazel"));
    await settle(30);
    expect(q('[data-testid="agent-thinking-row"]')).toBeNull();
  });

  it("Restore all leaves out the assistant before setup has run here (3)", async () => {
    // No coding tool yet, so nothing comes back by itself and the prompt shows.
    const { platform, restore, adopt } = adapter({
      flag: false,
      list: () => [],
      remote: () => [remoteRow(), remoteRow({ name: "scout", agentUid: "agt_scout" })],
    });
    (platform as unknown as { sessions: { preflight: () => Promise<unknown> } }).sessions.preflight = async () =>
      ok({
        claudeAvailable: true,
        claudeLoggedIn: false,
        codexAvailable: false,
        codexLoggedIn: false,
        grokAvailable: false,
        grokLoggedIn: false,
      });
    boot(platform);
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="bot-restore-all"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledWith("scout"));
    await settle(20);
    expect(restore, "the bulk restore would take the assistant").not.toHaveBeenCalled();
    expect(adopt.mock.calls.map((call) => call[0])).toEqual(["scout"]);
  });

  it("a background recovery that fails shows no start error on #welcome (2)", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    const { platform, adopt } = adapter({
      list: () => [],
      remote: () => [remoteRow()],
      adopt: async () => ({ ok: false, reason: "error", message: "boom" }),
    });
    boot(platform);
    await vi.waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    const welcome = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
      expect(el).toBeTruthy();
      return el!;
    });
    welcome.click();
    await settle(30);
    expect(q('[data-testid="setup-bot-error"]')).toBeNull();
    expect(screenText()).not.toMatch(/couldn't start/i);
  });
});

describe("the hq-cli version gate (5.345.87, hq-cli #1812)", () => {
  /** hq-cli #1812's `hq bot create setup --display-name X --json`, word for word in shape. */
  function cliCreateDoc(outcome: "existing" | "adopted" | "created") {
    return ok({
      ok: true,
      outcome,
      name: "setup",
      agentUid: ASSISTANT_UID,
      displayName: "Hazel",
      role: "assistant",
      nameSaved: "cloud",
      running: true,
    });
  }

  it("at 5.345.87 an assistant already here is named by create itself, with no profile write from the app", async () => {
    let here: LocalBotRow[] = [localRow({ displayName: "Popcorn" })];
    const { platform, create, updateAgentProfile } = adapter({
      flag: true,
      cliVersion: "5.345.87",
      list: () => here,
      create: async () => {
        here = [localRow({ displayName: "Hazel", role: "assistant" } as Partial<LocalBotRow>)];
        return cliCreateDoc("existing");
      },
    });
    boot(platform);
    await nameAssistant("Hazel");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "setup", displayName: "Hazel" }));
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await settle(20);
    expect(updateAgentProfile).not.toHaveBeenCalledWith(ASSISTANT_UID, expect.objectContaining({ displayName: expect.anything() }));
    expect(q('[data-testid="first-run-talk"]')?.textContent).toContain("Talk to Hazel");
  });

  it("below 5.345.87 the same assistant is named by the app, and create is never called", async () => {
    const { platform, create, updateAgentProfile } = adapter({
      flag: true,
      cliVersion: "5.345.86",
      list: () => [localRow({ displayName: "Popcorn" })],
    });
    boot(platform);
    await nameAssistant("Hazel");
    await vi.waitFor(() => expect(updateAgentProfile).toHaveBeenCalledWith(ASSISTANT_UID, { displayName: "Hazel" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("at 5.345.87 a create that adopted the account's assistant runs its kickoff: no handoff note", async () => {
    let here: LocalBotRow[] = [];
    const { platform, create, sendDm } = adapter({
      flag: true,
      cliVersion: "5.345.87",
      list: () => here,
      create: async () => {
        here = [localRow({ displayName: "Hazel" })];
        return cliCreateDoc("adopted");
      },
    });
    boot(platform);
    await nameAssistant("Hazel");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    q<HTMLButtonElement>('[data-testid="first-run-next"]')?.click();
    await vi.waitFor(() => expect(q<HTMLButtonElement>('[data-testid="first-run-talk"]')?.disabled).toBe(false));
    await settle(20);
    const keys = (sendDm.mock.calls as unknown as Array<[string, string, { idempotencyKey?: string }]>).map((c) => c[2]?.idempotencyKey);
    expect(keys).not.toContain(`first-run-handoff:${ASSISTANT_UID}`);
  });
});
