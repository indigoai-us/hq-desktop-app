// @vitest-environment happy-dom

/**
 * BOTS COME BACK BY THEMSELVES — NO BUTTON.
 *
 * The owner, on a fresh install: "I don't understand, the whole point of our
 * project was to automatically start up local bots when you installed the
 * app." He opened the setup bot's DM, typed "hi", and read "Not answered yet
 * — this bot isn't running on this computer", with the "Start on this
 * computer" notice above the fold where he never saw it. On the VM the
 * mechanism itself was fine: `hq bot restore --all --json` brought both bots
 * online in about five seconds.
 *
 * These pin the product change: the app runs that restore itself, says so in
 * one calm line, keeps the manual notice only for bots it genuinely cannot
 * bring back — and puts that notice at the BOTTOM of the conversation, next
 * to the composer, because the top is where the owner missed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter, type RemoteBotRow } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  AUTO_RESTORE_MAX_ATTEMPTS,
  AUTO_RESTORE_RUNNING,
  AUTO_RESTORE_STARTING_THIS_BOT,
  autoRestoreDoneLine,
} from "../chat/bot-auto-restore.js";
import { REMOTE_BOTS_POLL_MS } from "../chat/bot-restore.js";
import {
  BOT_MESSAGE_NOT_ANSWERED,
  BOT_MESSAGE_START_HERE,
  LOCAL_BOT_TRACE_KEY,
} from "../chat/bot-runnability.js";
import type { ChatSidebarApi } from "../chat/chat-api";
import type { ConversationRow } from "../chat/sidebar-model.js";

const SETUP_UID = "agt_setup";
const TEST_UID = "agt_test_bot";
/** A company bot: its identity lives in HQ Cloud and can never run on a Mac. */
const COMPANY_UID = "agt_izzy";

function remoteBot(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "setup",
    agentUid: SETUP_UID,
    kind: "personal",
    online: false,
    lastHeartbeatAt: null,
    here: false,
    runnable: true,
    ...over,
  } as RemoteBotRow;
}

function localBot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: SETUP_UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 4242,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date().toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    ...over,
  } as LocalBotRow;
}

function restoreResult(rows: Array<{ name: string; agentUid: string; action: string }>) {
  return {
    ok: true,
    dryRun: false,
    restored: rows.filter((r) => r.action === "restored").length,
    repaired: 0,
    skipped: 0,
    failed: rows.filter((r) => r.action === "failed").length,
    bots: rows.map((r) => ({ ...r, detail: "claude" })),
  };
}

interface Options {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>>;
  contacts?: Array<Record<string, unknown>>;
  /** Signed-in runtimes here. `false` is the fresh Mac before Connect Claude. */
  runtimeReady?: boolean | (() => boolean);
  messages?: Array<Record<string, unknown>>;
}

function adapter({ bots = {}, contacts = [], runtimeReady = true, messages = [] }: Options = {}): PlatformAdapter {
  const ready = typeof runtimeReady === "function" ? runtimeReady : () => runtimeReady;
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages }),
      sendDm: async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }),
      sendChannelMessage: async () => ok({ eventId: "evt_self_1", createdAt: new Date().toISOString() }),
      fetchReactions: async () => ok({ reactions: [] }),
    },
    notifications: { fetchDmInbox: async () => ok({}) },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    sessions: {
      preflight: async () =>
        ok({
          claudeAvailable: true,
          claudeLoggedIn: ready(),
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
    },
    bots: {
      list: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      listRemote: async () => ok({ bots: [] }),
      adopt: async () => ok({ ok: true }),
      restore: async () => ok(restoreResult([])),
      ...bots,
    },
  } as unknown as PlatformAdapter;
}

function dmRow(uid: string, title: string): ConversationRow {
  return { id: `dm:${uid}`, kind: "dm", title, personUid: uid } as ConversationRow;
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

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function mountApp(
  platform: PlatformAdapter,
  initialRow?: ConversationRow,
  sidebarApi: ChatSidebarApi = createFixtureChatSidebarApi(),
): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: platform,
      sidebarApi,
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_me", displayName: "Corey", email: "me@example.com" },
      coreFixtures: false,
      ...(initialRow ? { initialRow } : {}),
    },
  });
}

/** Type into the real composer and Enter-send, as a person does. */
async function sendPlainMessage(): Promise<void> {
  const composer = q<HTMLTextAreaElement>('[data-testid="conversation-composer"]');
  expect(composer, "live composer renders").toBeTruthy();
  composer!.value = "hi";
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(16);
}

/** Let mount, effects and any queued promises run under fake timers. */
async function flush(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/**
 * `vi.waitFor` runs on real time, which a fake clock never reaches. This is
 * the same idea on the fake one: keep draining microtasks (and any zero-delay
 * timer the shell queues while it boots) until the condition holds.
 */
async function until(what: string, check: () => boolean, tries = 80): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await flush(10);
  }
  throw new Error(`fake-timer wait never saw: ${what}`);
}

/**
 * `vi.waitFor` polls on its own clock and does not pump Svelte's effect queue,
 * which under a loaded run can time out on a shell that is merely slow. This
 * drains ticks between checks, so it waits for the app rather than the wall.
 */
async function waitFor(what: string, check: () => boolean, tries = 120): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await settle(4);
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`never saw: ${what}`);
}

/** A promise this test resolves by hand, so an in-flight state can be read. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("a fresh install brings the bots back by itself", () => {
  it("runs one restore with no click, says so, and never shows the prompt", async () => {
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof restoreResult>>>>();
    const restore = vi.fn(() => gate.promise);
    let here = false;
    mountApp(
      adapter({
        bots: {
          restore: restore as never,
          list: async () => ok({ bots: here ? [localBot(), localBot({ name: "test-bot", agentUid: TEST_UID })] : [] }),
          listRemote: async () =>
            ok({
              bots: [
                remoteBot({ here }),
                remoteBot({ name: "test-bot", agentUid: TEST_UID, here }),
              ],
            }),
        },
      }),
    );

    // No click anywhere: the app asks for itself, and says what it is doing.
    await vi.waitFor(() => expect(restore).toHaveBeenCalledWith({ all: true }));
    await vi.waitFor(() =>
      expect(q('[data-testid="bot-auto-restore-status"]')?.textContent?.trim()).toBe(
        AUTO_RESTORE_RUNNING,
      ),
    );
    // The prompt that asked for the click is not offered while this runs.
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();

    here = true;
    gate.resolve(
      ok(
        restoreResult([
          { name: "setup", agentUid: SETUP_UID, action: "restored" },
          { name: "test-bot", agentUid: TEST_UID, action: "restored" },
        ]),
      ) as never,
    );
    await vi.waitFor(() =>
      expect(q('[data-testid="bot-auto-restore-status"]')?.textContent?.trim()).toBe(
        autoRestoreDoneLine(["setup", "test-bot"]),
      ),
    );
    await settle(20);
    // One listing state, one restore.
    expect(restore).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="bot-restore-banner"]'), "no prompt after it worked").toBeNull();
  });

  it("waits for a signed-in runtime, then goes the moment there is one", async () => {
    // The fresh Mac before "Connect Claude": the account owns the bot, and
    // there is nothing here to run it with. Readiness is the one answer still
    // pending, and it is the trigger on its own — the listing never changes.
    const ready = deferred<Record<string, boolean>>();
    const restore = vi.fn(async () =>
      ok(restoreResult([{ name: "test-bot", agentUid: TEST_UID, action: "restored" }])),
    );
    const platform = adapter({
      bots: {
        restore: restore as never,
        list: async () => ok({ bots: [] }),
        listRemote: async () => ok({ bots: [remoteBot({ name: "test-bot", agentUid: TEST_UID })] }),
      },
    });
    (platform.sessions as { preflight: () => Promise<unknown> }).preflight = async () =>
      ok(await ready.promise);
    mountApp(platform);

    // Restoring a bot with no runtime to run it only produces a bot that
    // cannot start, so the app waits — and the manual prompt is the surface.
    await waitFor("the fallback prompt", () => q('[data-testid="bot-restore-banner"]') !== null);
    expect(restore, "no runtime, no automatic restore").not.toHaveBeenCalled();

    // The runtime signs in. Nothing else changes, and the bots come back.
    ready.resolve({
      claudeAvailable: true,
      claudeLoggedIn: true,
      codexAvailable: false,
      codexLoggedIn: false,
      grokAvailable: false,
      grokLoggedIn: false,
    });
    await waitFor("the automatic restore", () => restore.mock.calls.length > 0);
    expect(restore).toHaveBeenCalledWith({ all: true });
    // And the prompt stands down the moment the app takes it over.
    await waitFor("the prompt to stand down", () => q('[data-testid="bot-restore-banner"]') === null);
  });

  it("never brings a company bot back — it can only ever run in HQ Cloud", async () => {
    const restore = vi.fn(async () => ok(restoreResult([])));
    mountApp(
      adapter({
        bots: {
          restore: restore as never,
          list: async () => ok({ bots: [] }),
          listRemote: async () =>
            ok({
              bots: [
                remoteBot({ name: "izzy", agentUid: COMPANY_UID, kind: "company", runnable: false, reason: "company-bot" }),
              ],
            }),
        },
      }),
    );
    await settle(30);
    expect(restore).not.toHaveBeenCalled();
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();
    expect(q('[data-testid="bot-auto-restore-status"]')).toBeNull();
  });

  it("stands down while a person is driving a restore themselves", async () => {
    // No runtime yet, so nothing automatic runs and the prompt is the surface.
    // The person clicks it; the runtime then signs in mid-flight. One restore.
    const ready = deferred<Record<string, boolean>>();
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof restoreResult>>>>();
    const restore = vi.fn(() => gate.promise);
    const platform = adapter({
      bots: {
        restore: restore as never,
        list: async () => ok({ bots: [] }),
        listRemote: async () => ok({ bots: [remoteBot()] }),
      },
    });
    (platform.sessions as { preflight: () => Promise<unknown> }).preflight = async () =>
      ok(await ready.promise);
    mountApp(platform);

    await waitFor("the fallback prompt", () => q('[data-testid="bot-restore-banner"]') !== null);
    q<HTMLButtonElement>('[data-testid="bot-restore-all"]')!.click();
    await settle(10);
    expect(restore).toHaveBeenCalledTimes(1);

    ready.resolve({
      claudeAvailable: true,
      claudeLoggedIn: true,
      codexAvailable: false,
      codexLoggedIn: false,
      grokAvailable: false,
      grokLoggedIn: false,
    });
    await settle(40);
    await new Promise((r) => setTimeout(r, 20));
    await settle(20);
    expect(restore, "one restore, not two").toHaveBeenCalledTimes(1);
    gate.resolve(ok(restoreResult([{ name: "setup", agentUid: SETUP_UID, action: "restored" }])) as never);
    await settle(20);
  });
});

describe("when a bot cannot be brought back", () => {
  /** Every automatic try fails; the budget is what ends it. */
  function failingRestore() {
    return vi.fn(async () => ({
      ok: false as const,
      reason: "error" as const,
      message: 'HQ API /v1/agents/mine/restore → 500: {"code":"BOOM"}',
    }));
  }

  it("backs off between tries, gives up after three, and leaves the way out in the same line", async () => {
    vi.useFakeTimers();
    try {
      const restore = failingRestore();
      mountApp(
        adapter({
          bots: {
            restore: restore as never,
            list: async () => ok({ bots: [] }),
            listRemote: async () => ok({ bots: [remoteBot()] }),
          },
          contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }],
        }),
        dmRow(SETUP_UID, "setup"),
      );
      await until("the first automatic try", () => restore.mock.calls.length >= 1);

      // A fresh install lands two listings inside a second; the retry waits
      // rather than spending the budget on the same evidence twice.
      await flush(1_000);
      expect(restore, "no second try inside the back-off").toHaveBeenCalledTimes(1);

      // One listing period at a time, until the budget is gone.
      for (let i = 1; i < AUTO_RESTORE_MAX_ATTEMPTS; i += 1) {
        await flush(REMOTE_BOTS_POLL_MS);
        await until(`automatic try ${i + 1}`, () => restore.mock.calls.length >= i + 1);
      }
      await flush(REMOTE_BOTS_POLL_MS * 2);
      expect(restore, "three automatic tries per bot, then it stops").toHaveBeenCalledTimes(
        AUTO_RESTORE_MAX_ATTEMPTS,
      );

      // The manual surfaces are what is left, and nothing raw reached the screen.
      await until("the honest notice", () => q('[data-testid="bot-not-runnable-notice"]') !== null);
      expect(q('[data-testid="bot-start-here"]')?.textContent).toContain("Start on this computer");
      const shown = host.textContent ?? "";
      expect(shown).not.toContain("500");
      expect(shown).not.toContain("/v1/");
      // The prompt is offered again once nothing automatic is left to try.
      expect(q('[data-testid="bot-restore-banner"]'), "the fallback comes back").toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers an action in the same line even for a bot nothing here can run", async () => {
    // A company bot this Mac once ran: the listing says it is not runnable
    // here, so no automatic restore is possible and no adopt is offered — but
    // looking again is real, and it stays in the line the person is reading.
    window.localStorage.setItem(LOCAL_BOT_TRACE_KEY, JSON.stringify({ [COMPANY_UID]: "izzy" }));
    const restore = vi.fn(async () => ok(restoreResult([])));
    mountApp(
      adapter({
        bots: {
          restore: restore as never,
          adopt: undefined as never,
          list: async () => ok({ bots: [] }),
          listRemote: async () =>
            ok({
              bots: [remoteBot({ name: "izzy", agentUid: COMPANY_UID, kind: "company", runnable: false })],
            }),
        },
        contacts: [{ personUid: COMPANY_UID, displayName: "izzy", companyUid: null }],
      }),
      dmRow(COMPANY_UID, "izzy"),
    );
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeTruthy());
    expect(restore, "a company bot is never restored to a Mac").not.toHaveBeenCalled();

    await sendPlainMessage();
    const line = q('[data-testid="bot-message-unanswered"]');
    expect(line?.textContent).toContain(BOT_MESSAGE_NOT_ANSWERED);
    expect(line!.querySelector('[data-testid="bot-message-recheck"]')).toBeTruthy();
  });
});

describe("the dead-DM moment", () => {
  it("writing to a bot that isn't running starts it right there, and the message is answered", async () => {
    // The first automatic try failed, so the bot is still away and the app is
    // waiting for the next listing. The person does not wait: they type.
    let restores = 0;
    let here = false;
    const gate = deferred<ReturnType<typeof ok<ReturnType<typeof restoreResult>>>>();
    const restore = vi.fn(() => {
      restores += 1;
      if (restores === 1) {
        return Promise.resolve({ ok: false as const, reason: "error" as const, message: "boom" });
      }
      return gate.promise;
    });
    const sendDm = vi.fn(async () => ok({ eventId: "evt_1", createdAt: new Date().toISOString() }));
    mountApp(
      adapter({
        bots: {
          restore: restore as never,
          list: async () => ok({ bots: here ? [localBot()] : [] }),
          listRemote: async () => ok({ bots: [remoteBot({ here })] }),
        },
        contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }],
      }),
      dmRow(SETUP_UID, "setup"),
    );
    await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeTruthy());

    const platform = (component as unknown as Record<string, never>) && undefined;
    void platform;
    void sendDm;

    // The send itself is the trigger — no waiting for the 120 s listing.
    await sendPlainMessage();
    expect(restore, "the send brought the bot back immediately").toHaveBeenCalledTimes(2);
    expect(q('[data-testid="bot-message-starting"]')?.textContent?.trim()).toBe(
      AUTO_RESTORE_STARTING_THIS_BOT,
    );
    expect(q('[data-testid="bot-message-unanswered"]'), "never the dead sentence while it starts").toBeNull();

    // It comes back, and the conversation is a normal bot's again. The message
    // is not lost meanwhile: `hq dm` puts it in the bot's own durable inbox,
    // which the bot reads when it starts.
    here = true;
    gate.resolve(ok(restoreResult([{ name: "setup", agentUid: SETUP_UID, action: "restored" }])) as never);
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeNull());
    expect(q('[data-testid="bot-message-unanswered"]')).toBeNull();
    expect(q('[data-testid="bot-message-starting"]')).toBeNull();
  });
});

describe("where the notice lives", () => {
  it("renders after the last message and next to the composer — never at the top", async () => {
    // The owner's screenshot: the card sat above the oldest message under a
    // YESTERDAY divider, and he never saw it.
    const older = new Date(Date.now() - 86_400_000).toISOString();
    mountApp(
      adapter({
        // No runtime here, so the notice is the honest surface and stays put.
        runtimeReady: false,
        bots: { list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }) },
        contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }],
        messages: [
          { eventId: "evt_old", body: "yesterday's message", fromPersonUid: "prs_me", fromDisplayName: "Corey", createdAt: older },
        ],
      }),
      dmRow(SETUP_UID, "setup"),
    );

    const notice = await vi.waitFor(() => {
      const el = q('[data-testid="bot-not-runnable-notice"]');
      expect(el).toBeTruthy();
      return el!;
    });
    const thread = q('[data-testid="conversation-thread"]')!;
    const message = await vi.waitFor(() => {
      const el = thread.querySelector("[data-event-id]");
      expect(el, "the conversation has a message to sit under").toBeTruthy();
      return el!;
    });
    const composer = q('[data-testid="conversation-composer"]')!;

    // The message comes BEFORE the notice…
    expect(
      message.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the notice renders after the last message, not above the history",
    ).toBeTruthy();
    // …and the notice comes before the composer, with nothing but the thread's
    // own end in between.
    expect(
      notice.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the notice sits directly above the composer",
    ).toBeTruthy();
    // It is inside the conversation, not in the thread's header slot.
    expect(thread.contains(notice)).toBe(true);
    expect(thread.lastElementChild?.contains(notice) || thread.lastElementChild === notice).toBe(true);
  });
});
