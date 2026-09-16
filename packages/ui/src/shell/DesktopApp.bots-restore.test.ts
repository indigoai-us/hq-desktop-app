// @vitest-environment happy-dom

/**
 * BOTS COME BACK AFTER A REINSTALL.
 *
 * The owner's words: "i want bots to work after reinstall", and "shouldn't all
 * bots be restarted, or an option on the bot DM, if it's not started for any
 * reason?". What they actually saw was test-bot's DM spinning for 41 s while
 * the bot's own setup pane said it could not run here — because `hq bot list`
 * only knows this computer and the app had no way to see the bot the account
 * still owned in the cloud.
 *
 * `hq bot list --remote` closes that. These tests pin the four things it buys:
 *   - a DM with an owned bot that is NOT here says so at once, and a cloud
 *     teammate is untouched;
 *   - "Start on this computer" runs `hq bot adopt <name>` and the DM becomes a
 *     normal bot;
 *   - an adopt that fails says one written sentence and offers Retry;
 *   - the "restore my bots" prompt is offered once and then remembered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter, type RemoteBotRow } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  BOT_RESTORE_CLOUD_SIGN_IN,
  BOT_RESTORE_CLOUD_UNREACHABLE,
  BOT_RESTORE_DISMISSED_KEY,
  BOT_RESTORE_NEEDS_NEWER_CLOUD,
} from "../chat/bot-restore.js";
import { LOCAL_BOT_TRACE_KEY } from "../chat/bot-runnability.js";
import type { ChatSidebarApi } from "../chat/chat-api";
import type { ConversationRow } from "../chat/sidebar-model.js";

/** The owner's bot: owned in HQ, and nothing on this Mac can run it. */
const TEST_BOT_UID = "agt_test_bot";
/** A company bot that runs in the cloud — never on the local-bot listing. */
const FLEET_UID = "agt_fleet_izzy";

function remoteBot(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "test-bot",
    agentUid: TEST_BOT_UID,
    kind: "personal",
    online: false,
    lastHeartbeatAt: null,
    here: false,
    settings: "claude, synced memory",
    ...over,
  };
}

function localBot(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "test-bot",
    agentUid: TEST_BOT_UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "running",
    pid: 4242,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date().toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/test-bot",
    ...over,
  } as LocalBotRow;
}

interface Options {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>>;
  contacts?: Array<Record<string, unknown>>;
}

function adapter({ bots = {}, contacts = [] }: Options = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [] }),
      fetchDmThread: async () => ok({ messages: [] }),
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
          claudeLoggedIn: true,
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
      restore: async () =>
        ok({ ok: true, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 0, bots: [] }),
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

async function settle(times = 12): Promise<void> {
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
  composer!.value = "yo";
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(14);
}

describe("the account's own listing decides what can run here", () => {
  it("shows the honest notice for an owned bot that is not on this computer — no spinner", async () => {
    const start = vi.fn(async () => ok({}));
    mountApp(
      adapter({
        // This Mac has nothing; the account owns test-bot.
        bots: { list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }), start },
        contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
      }),
      dmRow(TEST_BOT_UID, "test-bot"),
    );

    const notice = await vi.waitFor(() => {
      const el = q('[data-testid="bot-not-runnable-notice"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(notice.textContent).toContain("another computer");
    // The gap this closes: a way out, not only "Check again".
    expect(q('[data-testid="bot-start-here"]')?.textContent).toContain("Start on this computer");

    // The 41-second spinner: writing to it must not start one.
    await sendPlainMessage();
    expect(q('[data-testid="agent-thinking-row"]'), "nothing is working on this").toBeNull();
    expect(q('[data-testid="bot-message-unanswered"]')?.textContent).toContain("isn't running");
    expect(start, "no doomed start is issued").not.toHaveBeenCalled();
  });

  it("leaves a cloud teammate alone — it is not a local bot and never was on that listing", async () => {
    mountApp(
      adapter({
        bots: { list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }) },
        contacts: [{ personUid: FLEET_UID, displayName: "izzy", companyUid: "cmp_indigo" }],
      }),
      dmRow(FLEET_UID, "izzy"),
    );
    await settle(20);

    expect(q('[data-testid="bot-not-runnable-notice"]'), "a cloud bot is not called unrunnable").toBeNull();
    await sendPlainMessage();
    expect(q('[data-testid="agent-thinking-row"]'), "a cloud teammate still thinks").toBeTruthy();
  });
});

describe("Start on this computer", () => {
  it("brings the bot back by name and the DM becomes a normal bot", async () => {
    const adopt = vi.fn(async () => ok({ ok: true, name: "test-bot", agentUid: TEST_BOT_UID }));
    let here = false;
    mountApp(
      adapter({
        bots: {
          adopt,
          list: async () => ok({ bots: here ? [localBot()] : [] }),
          listRemote: async () => ok({ bots: [remoteBot({ here })] }),
        },
        contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
      }),
      dmRow(TEST_BOT_UID, "test-bot"),
    );

    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="bot-start-here"]');
      expect(el).toBeTruthy();
      return el!;
    });

    // The CLI succeeds and the bot is here from the next listing on.
    adopt.mockImplementation(async () => {
      here = true;
      return ok({ ok: true, name: "test-bot", agentUid: TEST_BOT_UID });
    });
    button.click();
    await settle(24);

    // `hq bot adopt <name>` — the local folder name, not the uid.
    expect(adopt).toHaveBeenCalledWith("test-bot");
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeNull());
    // And it is a normal bot again: a message it is sent is worked on.
    await sendPlainMessage();
    expect(q('[data-testid="bot-message-unanswered"]')).toBeNull();
  });

  it("says one plain sentence and offers Retry when the bring-back fails", async () => {
    const adopt = vi.fn(async () => ({
      ok: false as const,
      reason: "unavailable" as const,
      // Exactly the kind of text that must never reach a person.
      message: 'HQ API /v1/agents/agt_test_bot/credentials → 403: {"code":"NOT_OWNER"}',
    }));
    mountApp(
      adapter({
        bots: {
          adopt: adopt as never,
          list: async () => ok({ bots: [] }),
          listRemote: async () => ok({ bots: [remoteBot()] }),
        },
        contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
      }),
      dmRow(TEST_BOT_UID, "test-bot"),
    );

    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="bot-start-here"]');
      expect(el).toBeTruthy();
      return el!;
    });
    button.click();
    await settle(20);

    const error = await vi.waitFor(() => {
      const el = q('[data-testid="bot-start-here-error"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(error.textContent).toContain("Could not bring test-bot back to this computer");
    expect(error.textContent).not.toContain("403");
    expect(error.textContent).not.toContain("/v1/");
    // One more go is offered, on the same button.
    expect(q('[data-testid="bot-start-here"]')?.textContent?.trim()).toBe("Retry");
    q<HTMLButtonElement>('[data-testid="bot-start-here"]')!.click();
    await settle(20);
    expect(adopt).toHaveBeenCalledTimes(2);
  });
});

describe("Restore my bots", () => {
  it("asks once after a fresh install, restores them all, and is not asked again", async () => {
    const restore = vi.fn(async () =>
      ok({
        ok: true,
        dryRun: false,
        restored: 2,
        repaired: 0,
        skipped: 0,
        failed: 0,
        bots: [
          { name: "test-bot", agentUid: TEST_BOT_UID, action: "restored" as const, detail: "claude" },
          { name: "iris", agentUid: "agt_iris", action: "restored" as const, detail: "claude" },
        ],
      }),
    );
    mountApp(
      adapter({
        bots: {
          restore,
          list: async () => ok({ bots: [] }),
          listRemote: async () =>
            ok({ bots: [remoteBot(), remoteBot({ name: "iris", agentUid: "agt_iris" })] }),
        },
      }),
    );

    const prompt = await vi.waitFor(() => {
      const el = q('[data-testid="bot-restore-banner"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(prompt.textContent).toContain("2 of your bots aren't");

    q<HTMLButtonElement>('[data-testid="bot-restore-all"]')!.click();
    await settle(24);

    expect(restore).toHaveBeenCalledWith({ all: true });
    expect(q('[data-testid="bot-restore-summary"]')?.textContent).toBe("2 bots are back on this computer.");
    expect(q('[data-testid="bot-restore-row-iris"]')?.textContent).toContain("is back on this computer");
    // Asking counts as answering: this machine is not prompted again.
    expect(window.localStorage.getItem(BOT_RESTORE_DISMISSED_KEY)).toBe("1");
  });

  it("stays dismissed on the next launch, so it never nags", async () => {
    const restore = vi.fn(async () =>
      ok({ ok: true, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 0, bots: [] }),
    );
    // First launch: offered, and turned down.
    mountApp(
      adapter({
        bots: { restore, list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }) },
      }),
    );
    await vi.waitFor(() => expect(q('[data-testid="bot-restore-banner"]')).toBeTruthy());
    q<HTMLButtonElement>('[data-testid="bot-restore-dismiss"]')!.click();
    await settle();
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();

    // Next launch, same machine, same missing bot.
    await unmount(component!);
    component = null;
    host.remove();
    mountApp(
      adapter({
        bots: { restore, list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }) },
      }),
    );
    await settle(24);
    expect(q('[data-testid="bot-restore-banner"]'), "asked once, not every launch").toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });

  it("is never offered when every bot the account owns is already here", async () => {
    mountApp(
      adapter({
        bots: {
          list: async () => ok({ bots: [localBot()] }),
          listRemote: async () => ok({ bots: [remoteBot({ here: true })] }),
        },
      }),
    );
    await settle(24);
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();
  });
});

/**
 * THE LISTING IS AN ENHANCEMENT, NEVER A GATE.
 *
 * The owner's VM ran the whole feature against the production HQ Cloud, which
 * does not have the listing route yet: `hq bot list --remote` answered
 * `HQ API /v1/agents/mine → 404: Not found` every time. Because the app read
 * runnability from that one call, everything the previous round had fixed came
 * back — four of the owner's own local bots were drawn as `Cloud`, a wiped
 * bot's DM showed a normal composer with NO notice, and one message spun for
 * 2 m 39 s (report rows T2.1, T2.4, T5.2).
 *
 * These pin the rule that makes the failure harmless: runnability comes from
 * local evidence first, and a listing that failed can only change what the app
 * OFFERS — never what it claims.
 */
describe("when HQ Cloud cannot list your bots", () => {
  /** Exactly what the VM's CLI wrote: a route this server does not have. */
  const CLOUD_UNSUPPORTED = {
    ok: false as const,
    reason: "error" as const,
    message: "HQ API /v1/agents/mine → 404: Not found",
  };
  /** The CLI's own JSON contract, once the CLI lane lands. */
  const CLOUD_UNSUPPORTED_JSON = {
    ok: false as const,
    reason: "error" as const,
    message: JSON.stringify({
      ok: false,
      reason: "server-unsupported",
      message: "This HQ Cloud cannot list the bots you own yet.",
      bots: [],
    }),
  };
  const CLOUD_OFFLINE = {
    ok: false as const,
    reason: "error" as const,
    message: "hq bot list --remote did not finish within 60s",
  };
  const CLOUD_REFUSED = {
    ok: false as const,
    reason: "error" as const,
    message: "HQ API /v1/agents/mine → 401: Unauthorized",
  };

  /** This Mac ran test-bot; then its config was wiped (the VM's Step E). */
  function rememberItRanHere(): void {
    window.localStorage.setItem(LOCAL_BOT_TRACE_KEY, JSON.stringify({ [TEST_BOT_UID]: "test-bot" }));
  }

  function wipedBotAdapter(listRemote: () => Promise<never> | Promise<unknown>): PlatformAdapter {
    return adapter({
      bots: {
        list: async () => ok({ bots: [] }),
        listRemote: listRemote as never,
      },
      contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
    });
  }

  async function openWipedBotDm(
    listRemote: () => Promise<unknown>,
    start = vi.fn(async () => ok({})),
  ): Promise<HTMLElement> {
    rememberItRanHere();
    mountApp(
      adapter({
        bots: { list: async () => ok({ bots: [] }), listRemote: listRemote as never, start },
        contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
      }),
      dmRow(TEST_BOT_UID, "test-bot"),
    );
    return await vi.waitFor(() => {
      const el = q('[data-testid="bot-not-runnable-notice"]');
      expect(el, "the honest notice survives a listing that failed").toBeTruthy();
      return el!;
    });
  }

  it("keeps the honest notice and the silence on send when the route is missing (T5.2)", async () => {
    const start = vi.fn(async () => ok({}));
    const notice = await openWipedBotDm(async () => CLOUD_UNSUPPORTED, start);
    expect(notice.textContent).toContain("another computer");

    // The 2 m 39 s spinner: writing to this bot must not start one.
    await sendPlainMessage();
    expect(q('[data-testid="agent-thinking-row"]'), "nothing is working on this").toBeNull();
    expect(q('[data-testid="bot-message-unanswered"]')?.textContent).toContain("isn't running");
    expect(start, "no doomed start is issued").not.toHaveBeenCalled();

    // Bringing it back goes through HQ Cloud, which has no such route: the
    // button is not offered, and one plain sentence says why instead.
    expect(q('[data-testid="bot-start-here"]')).toBeNull();
    expect(q('[data-testid="bot-restore-unavailable"]')?.textContent?.trim()).toBe(
      BOT_RESTORE_NEEDS_NEWER_CLOUD,
    );
    // "Check again" stays: this Mac's own bots can change without HQ Cloud.
    expect(q('[data-testid="bot-not-runnable-recheck"]')).toBeTruthy();
    // And nothing raw reaches the screen.
    const shown = notice.textContent ?? "";
    expect(shown).not.toContain("404");
    expect(shown).not.toContain("/v1/");
    expect(shown).not.toContain("hq bot");
    // Nothing can be restored, so the prompt is not offered either.
    expect(q('[data-testid="bot-restore-banner"]')).toBeNull();
  });

  it("reads the CLI's own failure contract the same way as its raw text", async () => {
    await openWipedBotDm(async () => CLOUD_UNSUPPORTED_JSON);
    expect(q('[data-testid="bot-restore-unavailable"]')?.textContent?.trim()).toBe(
      BOT_RESTORE_NEEDS_NEWER_CLOUD,
    );
    expect(q('[data-testid="bot-start-here"]')).toBeNull();
  });

  it("says it could not be reached, and offers Check again, on a network failure", async () => {
    const start = vi.fn(async () => ok({}));
    await openWipedBotDm(async () => CLOUD_OFFLINE, start);
    await sendPlainMessage();
    expect(q('[data-testid="agent-thinking-row"]')).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(q('[data-testid="bot-restore-unavailable"]')?.textContent?.trim()).toBe(
      BOT_RESTORE_CLOUD_UNREACHABLE,
    );
    expect(q('[data-testid="bot-not-runnable-recheck"]')).toBeTruthy();
  });

  it("asks the person to sign in again when the listing is refused", async () => {
    await openWipedBotDm(async () => CLOUD_REFUSED);
    expect(q('[data-testid="bot-restore-unavailable"]')?.textContent?.trim()).toBe(
      BOT_RESTORE_CLOUD_SIGN_IN,
    );
    expect(q('[data-testid="bot-not-runnable-recheck"]')).toBeTruthy();
  });

  it("treats an answer it cannot read as no answer, never as a bot that is missing", async () => {
    // A host that answers `ok` with nothing at all (the null payload that once
    // crashed the refresh). The notice still comes from local evidence.
    await openWipedBotDm(async () => ok(null as never));
    expect(q('[data-testid="bot-restore-unavailable"]')?.textContent?.trim()).toBe(
      BOT_RESTORE_CLOUD_UNREACHABLE,
    );
  });

  it("offers the way out again as soon as the listing works", async () => {
    // Same wiped bot, a server that HAS the route: nothing about the honest
    // notice changes, and "Start on this computer" is back.
    rememberItRanHere();
    mountApp(
      adapter({
        bots: { list: async () => ok({ bots: [] }), listRemote: async () => ok({ bots: [remoteBot()] }) },
        contacts: [{ personUid: TEST_BOT_UID, displayName: "test-bot", companyUid: null }],
      }),
      dmRow(TEST_BOT_UID, "test-bot"),
    );
    await vi.waitFor(() => expect(q('[data-testid="bot-start-here"]')).toBeTruthy());
    expect(q('[data-testid="bot-restore-unavailable"]')).toBeNull();
  });

  it("never draws one of the person's own bots as Cloud because the listing failed", async () => {
    // The VM's Observation: `setup Cloud`, `cobot Cloud`, `test-bot Cloud` and
    // a wiped `qa-20260916a Cloud` — every one of them the owner's local bot.
    rememberItRanHere();
    const iso = new Date().toISOString();
    const sidebarApi: ChatSidebarApi = {
      ...createFixtureChatSidebarApi(),
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "cur_1",
        cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        rows: [],
      }),
      listContacts: async () => ({
        contacts: [
          { personUid: TEST_BOT_UID, displayName: "test-bot", lastActivityAt: iso, lastDmAt: iso },
          { personUid: FLEET_UID, displayName: "izzy", lastActivityAt: iso, lastDmAt: iso },
        ],
      }),
    } as ChatSidebarApi;
    mountApp(wipedBotAdapter(async () => CLOUD_UNSUPPORTED), undefined, sidebarApi);

    const chipFor = (uid: string) =>
      q(`[data-conversation-id="dm:${uid}"] [data-testid="bot-kind-chip"]`);
    await vi.waitFor(() => {
      expect(chipFor(TEST_BOT_UID)).toBeTruthy();
      expect(chipFor(FLEET_UID)).toBeTruthy();
    });
    expect(chipFor(TEST_BOT_UID)?.getAttribute("aria-label")).toBe("Local");
    expect(chipFor(TEST_BOT_UID)?.dataset.kind).toBe("local");
    // A bot this computer has no trace of is still a cloud teammate: nothing
    // about anyone else's bot changes.
    expect(chipFor(FLEET_UID)?.getAttribute("aria-label")).toBe("Cloud");
    expect(chipFor(FLEET_UID)?.dataset.kind).toBe("cloud");
  });
});
