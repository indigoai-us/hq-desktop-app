// @vitest-environment happy-dom

/**
 * Setup needs a coding tool before the setup bot runs.
 *
 * A freshly wiped test Mac with no Claude Code and no Codex finished setup,
 * the account's setup bot came back to the Mac, and every message to it came
 * back as "Sorry ... (claude kept failing: claude is not installed or not on
 * PATH)" until the bot stopped. The guided install the app already has was
 * never offered.
 *
 * Now: with no coding tool signed in, #welcome shows the install guide before
 * anything else, the setup bot is neither created nor opened, and a bot DM
 * that does hold such a failure reply shows a plain sentence plus the guide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { SETUP_ROW_ID, WELCOME_SETUP_RUN_KEY } from "../chat/setup-channel.js";
import { requestConversation, takePendingConversation } from "../chat/pending-conversation.js";

const SETUP_BOT_UID = "agt_setup_taffy";
const EM = "\u2014";
const RAW_REPLY = `Sorry ${EM} I couldn't answer that one (claude kept failing: claude is not installed or not on PATH). Try again in a bit, or check that claude is signed in on this computer.`;

function setupBotRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "setup",
    displayName: "Taffy",
    agentUid: SETUP_BOT_UID,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "failed",
    pid: null,
    processAlive: false,
    online: false,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/.hq/bots/setup",
    workerId: "setup",
    ...over,
  } as LocalBotRow;
}

interface Options {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>>;
  contacts?: Array<Record<string, unknown>>;
  dm?: Array<Record<string, unknown>>;
  claudeReady?: boolean;
}

function adapter({ bots = {}, contacts = [], dm = [], claudeReady = false }: Options = {}): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ok({ messages: [...dm].reverse(), nextCursor: null }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: {
      detectAiTools: async () =>
        ok({ claude_cli: false, claude_desktop: false, codex_cli: false, codex_desktop: false, any: false }),
    },
    sessions: {
      // The VM's preflight: nothing installed, nothing signed in.
      preflight: async () =>
        ok({
          claudeAvailable: claudeReady,
          claudeLoggedIn: claudeReady,
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

function installGuide() {
  return {
    oninstall: vi.fn(async () => ({ ok: true })),
    onsignin: vi.fn(() => new Promise<{ ok: boolean }>(() => undefined)),
    onrefresh: vi.fn(async () => undefined),
    downloadUrlFor: () => "https://claude.com/download",
    onopen: vi.fn(() => undefined),
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  takePendingConversation();
  window.localStorage.clear();
});

afterEach(async () => {
  takePendingConversation();
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

async function mountApp(
  platform: PlatformAdapter,
  sidebarApi: ReturnType<typeof createFixtureChatSidebarApi> = createFixtureChatSidebarApi(),
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: platform,
      sidebarApi,
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
      setupInstallGuide: installGuide(),
    },
  });
  await settle();
}

async function openWelcome(): Promise<void> {
  const row = q<HTMLButtonElement>(`[data-conversation-id="${SETUP_ROW_ID}"]`);
  expect(row, "pinned #welcome row renders").toBeTruthy();
  row!.click();
  await settle();
}

describe("no coding tool on this computer", () => {
  it("shows the install guide on #welcome and never creates the setup bot", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await mountApp(adapter({ bots: { create } }));
    await openWelcome();

    await vi.waitFor(() => expect(q('[data-testid="setup-install-guide"]')).toBeTruthy());
    expect(q('[data-testid="setup-bot-error"]')?.textContent).toContain("needs a coding tool signed in");
    // The guide owns the next step: no "Open Setup Agent" that would only fail.
    expect(q('[data-testid="setup-run"]')).toBeNull();
    await settle(20);
    expect(create).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(WELCOME_SETUP_RUN_KEY)).toBeNull();
  });

  it("does not open the account's existing setup bot either; the guide comes first", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: "agt_new" }));
    const adopt = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await mountApp(
      adapter({
        bots: { create, adopt },
        // The bot from an earlier install is still on the account.
        contacts: [{ personUid: SETUP_BOT_UID, displayName: "setup", companyUid: null }],
      }),
    );
    await openWelcome();

    await vi.waitFor(() => expect(q('[data-testid="setup-install-guide"]')).toBeTruthy());
    await settle(20);
    expect(create).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    // Still on #welcome, not in a DM with a bot that cannot answer.
    expect(q('[data-testid="setup-channel-intro"]')).toBeTruthy();
  });

  it("with a coding tool signed in there is no guide and the setup bot starts", async () => {
    const create = vi.fn(async () => ok({ ok: true, name: "setup", agentUid: SETUP_BOT_UID }));
    await mountApp(adapter({ bots: { create }, claudeReady: true }));
    await openWelcome();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(q('[data-testid="setup-install-guide"]')).toBeNull();
  });
});

describe("a bot turn that failed because the coding tool is missing", () => {
  it("shows a plain sentence and the install guide, never the CLI's words", async () => {
    window.localStorage.setItem(WELCOME_SETUP_RUN_KEY, "1");
    requestConversation({ personUid: SETUP_BOT_UID, email: "", displayName: "Taffy" });
    const now = new Date().toISOString();
    await mountApp(
      adapter({
        bots: { list: async () => ok({ bots: [setupBotRow()] }) },
        dm: [
          { eventId: "e1", fromPersonUid: "prs_test", body: "hey friend", createdAt: "2026-10-08T16:02:10.000Z" },
          { eventId: "e2", fromPersonUid: SETUP_BOT_UID, body: RAW_REPLY, createdAt: "2026-10-08T16:02:12.000Z" },
        ],
      }),
      {
        ...createFixtureChatSidebarApi(),
        listContacts: async () => ({
          contacts: [
            { personUid: SETUP_BOT_UID, email: "", displayName: "Taffy", lastMessageAt: now, lastActivityAt: now },
          ],
        }),
      } as ReturnType<typeof createFixtureChatSidebarApi>,
    );
    await vi.waitFor(() => expect(q('[data-testid="channel-name"]')?.textContent?.trim()).toBe("Taffy"));
    await settle(20);

    await vi.waitFor(() =>
      expect(host.textContent).toContain("I couldn't answer because Claude Code isn't installed on this"),
    );
    const text = host.textContent ?? "";
    expect(text).not.toContain("not on PATH");
    expect(text).not.toContain("kept failing");
    expect(q('[data-testid="bot-needs-coding-tool"]')?.textContent).toContain("needs Claude Code on this");
    expect(q('[data-testid="bot-needs-coding-tool-guide"] [data-testid="setup-install-guide"]')).toBeTruthy();
  });
});
