// @vitest-environment happy-dom

/**
 * After a Local bot is created its DM opens immediately with a progress card
 * — Creating identity → Installing on this Mac → Online — because the bot's
 * intro message has not landed yet. Presence (adapter.bots.list) drives the
 * card: online ticks it off and removes it; a failed process shows the reason
 * with one Retry, which starts the bot again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { LOCAL_BOTS_POLL_MS } from "../chat/local-bots.js";

const BOT_UID = "agt_new";

function botRow(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "scout",
    agentUid: BOT_UID,
    ownerUid: "prs_test",
    runtime: "claude",
    state: "running",
    pid: 7,
    processAlive: true,
    online: false,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/HQ/personal/workers/scout",
    ...over,
  };
}

/** The host's bot list, swapped between polls to simulate the bot coming up. */
let rows: LocalBotRow[] = [];
let start: ReturnType<typeof vi.fn>;

function adapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
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
      preflight: async () => ok({ claudeAvailable: true, claudeLoggedIn: true, codexAvailable: false, codexLoggedIn: false, grokAvailable: false, grokLoggedIn: false }),
    },
    bots: {
      list: async () => ok({ bots: rows }),
      // The CLI provisions the bot: only then does it show up in `list`.
      create: async () => {
        rows = [botRow({ online: false })];
        return ok({ ok: true, name: "scout", agentUid: BOT_UID });
      },
      start,
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  rows = [];
  start = vi.fn(async () => ok({}));
  window.localStorage?.clear?.();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="chat-create-modal"]').forEach((n) => n.remove());
  vi.useRealTimers();
  window.localStorage?.clear?.();
});

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function click(sel: string): void {
  const el = q<HTMLButtonElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
}

/** One poll cycle: the host re-reads adapter.bots.list. */
async function poll(): Promise<void> {
  await vi.advanceTimersByTimeAsync(LOCAL_BOTS_POLL_MS);
  await settle();
}

/** "+" → New bot → Blank → Local → Details → Create. */
async function createBot(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Test", email: "test@example.com" },
      coreFixtures: false,
    },
  });
  for (let i = 0; i < 40 && !host.querySelector('[data-testid="chat-new-message"]'); i += 1) await settle();
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await settle();
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  click('[data-testid="create-bot-next"]');
  await settle();
  click('[data-testid="create-bot-next"]');
  await settle();
  const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
  name.value = "scout";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="chat-bot-create"]');
  await settle(20);
}

describe("DesktopApp local bot progress card", () => {
  it("shows the progress card in the new bot's DM until presence reports it online", async () => {
    // Nothing on this Mac yet; `create` installs the bot, still not checked in.
    await createBot();

    const card = q('[data-testid="bot-progress-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-state")).toBe("installing");
    expect(card?.textContent).toContain("Setting up scout");
    expect(q('[data-testid="bot-progress-step-installing"]')?.getAttribute("data-step-state")).toBe("active");

    // It checks in: the card ticks over to Online and then leaves the timeline.
    rows = [botRow({ online: true, lastHeartbeatAt: new Date().toISOString() })];
    await poll();
    expect(q('[data-testid="bot-progress-card"]')?.getAttribute("data-state")).toBe("online");
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();
    expect(q('[data-testid="bot-progress-card"]')).toBeNull();
  });

  it("a bot that dies on this Mac shows the reason with a Retry that starts it again", async () => {
    await createBot();
    expect(q('[data-testid="bot-progress-card"]')).toBeTruthy();

    rows = [botRow({ online: false, state: "failed", processAlive: false })];
    await poll();
    const card = q('[data-testid="bot-progress-card"]');
    expect(card?.getAttribute("data-state")).toBe("failed");
    expect(q('[data-testid="bot-progress-reason"]')?.textContent).toContain("stopped after repeated errors");
    // The failure is pinned to the step it died on, not to "Online".
    expect(q('[data-testid="bot-progress-step-installing"]')?.getAttribute("data-step-state")).toBe("failed");

    rows = [botRow({ online: false, state: "running", processAlive: true })];
    click('[data-testid="bot-progress-retry"]');
    await settle(20);
    expect(start).toHaveBeenCalledWith("scout");
    expect(q('[data-testid="bot-progress-card"]')?.getAttribute("data-state")).toBe("installing");
  });
});
