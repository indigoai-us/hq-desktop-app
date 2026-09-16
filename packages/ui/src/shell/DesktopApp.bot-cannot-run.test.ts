// @vitest-environment happy-dom

/**
 * A BOT THAT CANNOT RUN HERE SAYS SO (desktop UX feedback, round 5).
 *
 * What the owner saw on a fresh Mac signed in to the same HQ account: Run
 * Setup adopted the setup bot the account already owned in the cloud and
 * opened its DM. They typed "yo". The row said "setup is still working…
 * working for 2m18s" and never resolved, because nothing on that Mac could
 * run the bot — `~/.hq/bots/setup/` held a log and no config, and the same
 * doomed start was re-issued ~48 times while the app showed a normal
 * thinking bot.
 *
 * Three things must be true now:
 *   - an adopted bot with no local runtime is presented as what it is;
 *   - a definitive start failure is issued once, never in a loop;
 *   - that failure is the newer event that ends the thinking row (never a
 *     timer — policy transient-indicators-clear-on-newer-event-not-time-window).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { BOT_START_MAX_ATTEMPTS } from "../chat/bot-runnability.js";
import type { ConversationRow } from "../chat/sidebar-model.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";

/** The line the guest's bot.log carried 48 times over. */
const NO_SUCH_BOT = 'No bot named "setup". Create one with: hq bot create setup';
/** A start the CLI never answered — the one failure worth another go. */
const CLI_TIMEOUT = "hq bot start setup did not finish within 60s";
const SETUP_UID = "agt_cloud_setup";

function botRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    agentUid: SETUP_UID,
    ownerUid: "prs_me",
    runtime: "claude",
    state: "stopped",
    pid: null,
    processAlive: false,
    online: false,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: false,
    dir: "/tmp/.hq/bots/setup",
    workerId: "setup",
    ...over,
  } as LocalBotRow;
}

interface Options {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>>;
  contacts?: Array<Record<string, unknown>>;
  messages?: Array<Record<string, unknown>>;
}

function adapter({ bots = {}, contacts = [], messages = [] }: Options = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ok({ messages: [...messages].reverse() }),
      fetchDmThread: async () => ok({ messages: [...messages].reverse() }),
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
      create: async () => ok({ ok: true, name: "setup", agentUid: "agt_new" }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      ...bots,
    },
  } as unknown as PlatformAdapter;
}

const SETUP_DM_ROW = {
  id: `dm:${SETUP_UID}`,
  kind: "dm",
  title: "setup",
  personUid: SETUP_UID,
} as ConversationRow;

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

function mountApp(platform: PlatformAdapter, initialRow?: ConversationRow): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: platform,
      sidebarApi: createFixtureChatSidebarApi(),
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
  expect(composer, "live composer renders for the bot's DM").toBeTruthy();
  composer!.value = "yo";
  composer!.dispatchEvent(new Event("input", { bubbles: true }));
  composer!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(12);
}

describe("an adopted bot with no runtime on this Mac", () => {
  it("is presented as what it is — and nothing is created or started for it", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: "agt_new" }));
    const start = vi.fn(async () => ok({}));
    // `hq bot list` is empty (this Mac has no bots); the cloud roster still
    // carries the setup bot this account owns.
    mountApp(
      adapter({
        bots: { create, start, list: async () => ok({ bots: [] }) },
        contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }],
      }),
    );

    // The automatic first-open start adopts it and opens the DM.
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent).toContain("setup"));
    const notice = await vi.waitFor(() => {
      const el = q('[data-testid="bot-not-runnable-notice"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(notice.textContent).toContain("another computer");
    // The one action offered is one the desktop can actually perform.
    expect(q('[data-testid="bot-not-runnable-recheck"]')?.textContent).toContain("Check again");
    // No duplicate bot, and no doomed start — then, or ever.
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    await settle(40);
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not leave the message the person sent it under a spinner", async () => {
    mountApp(
      adapter({
        bots: { list: async () => ok({ bots: [] }) },
        contacts: [{ personUid: SETUP_UID, displayName: "setup", companyUid: null }],
      }),
    );
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeTruthy());

    await sendPlainMessage();

    expect(q('[data-testid="agent-thinking-row"]'), "no bot is thinking about this").toBeNull();
    expect(q('[data-testid="bot-message-unanswered"]')?.textContent).toContain("isn't running");
  });
});

describe("a start that cannot succeed is issued once", () => {
  /** A listed bot whose start answers "no such bot" — the guest's own state. */
  function mountWithFailingStart(message: string, startImpl?: () => Promise<unknown>) {
    const start = vi.fn(
      startImpl ??
        (async () => ({ ok: false as const, reason: "unavailable" as const, message })),
    );
    mountApp(
      adapter({ bots: { start: start as never, list: async () => ok({ bots: [botRow()] }) } }),
      SETUP_DM_ROW,
    );
    return start;
  }

  it("stops after the first definitive failure, and says the honest thing", async () => {
    const start = mountWithFailingStart(NO_SUCH_BOT);
    // The bot is listed but offline, so the conversation offers Start.
    const button = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="local-bot-start"]');
      expect(el).toBeTruthy();
      return el!;
    });

    // The person writes to it first: the indicator is running when the start
    // fails, which is exactly how the row got stuck on the VM.
    await sendPlainMessage();
    expect(q('[data-testid="agent-thinking-row"]'), "the bot is shown as thinking").toBeTruthy();

    button.click();
    await vi.waitFor(() => expect(q('[data-testid="bot-not-runnable-notice"]')).toBeTruthy());
    expect(start).toHaveBeenCalledOnce();

    // The failure IS the newer event: the row is gone, and the honest state
    // stands in its place. No timer was involved.
    expect(q('[data-testid="agent-thinking-row"]')).toBeNull();
    expect(q('[data-testid="bot-not-runnable-notice"]')?.textContent).toContain("another computer");
    // Nothing offers the start that cannot work any more.
    expect(q('[data-testid="local-bot-start"]')).toBeNull();
    await settle(40);
    expect(start).toHaveBeenCalledOnce();
  });

  it("retries a transient failure, but a bounded number of times", async () => {
    const start = mountWithFailingStart(CLI_TIMEOUT);
    await vi.waitFor(() => expect(q('[data-testid="local-bot-start"]')).toBeTruthy());

    for (let i = 0; i < BOT_START_MAX_ATTEMPTS + 3; i += 1) {
      const button = q<HTMLButtonElement>('[data-testid="local-bot-start"]');
      if (!button) break;
      button.click();
      await settle(12);
    }

    expect(start).toHaveBeenCalledTimes(BOT_START_MAX_ATTEMPTS);
    expect(q('[data-testid="local-bot-start"]'), "the app has stopped offering it").toBeNull();
  });

  it("never quotes the CLI or the API, whichever way the start fails", async () => {
    for (const message of [NO_SUCH_BOT, CLI_TIMEOUT]) {
      mountWithFailingStart(message);
      await vi.waitFor(() => expect(q('[data-testid="local-bot-start"]')).toBeTruthy());
      q<HTMLButtonElement>('[data-testid="local-bot-start"]')!.click();
      await settle(12);

      const shown = host.textContent ?? "";
      expect(shown).not.toContain("hq bot create");
      expect(shown).not.toContain("HQ API");
      expect(shown).not.toContain("No bot named");
      expect(shown).not.toContain("did not finish within");

      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });
});

describe("the fresh-install welcome", () => {
  it("still offers Run Setup when nothing has been adopted yet", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    mountApp(adapter({ bots: { list: async () => ok({ bots: [] }) } }));
    await settle();
    const row = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
    expect(row, "#welcome is still there").toBeTruthy();
  });
});
