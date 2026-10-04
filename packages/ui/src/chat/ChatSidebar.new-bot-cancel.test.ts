// @vitest-environment happy-dom

/**
 * Cancel in the new cloud bot flow, through the sidebar (US-016).
 *
 * Cancel stops the create and removes what it made. The sidebar owns that
 * work, so it keeps going when the takeover closes, and an answer that arrives
 * after Cancel still gets its bot removed. Every server call here is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { CloudBotDraft, EntryPointResult } from "./lifecycle-entry-points.js";
import { CREATE_KEYS_STORAGE_KEY } from "./create-bot/create-key.js";
import {
  OPEN_BOT_REMOVALS_STORAGE_KEY,
  REMOVED_BOTS_STORAGE_KEY,
} from "./create-bot/cancel-model.js";
import { BOT_SETUP_CHANNELS_STORAGE_KEY } from "./sidebar-model.js";
import { tenantStorageKey } from "../identity/tenant-storage.js";
import { resetWakingSessionStores, WAKING_BOTS_STORAGE_KEY } from "./create-bot/waking-sessions.js";
import { registerShortcuts, runShortcut, shortcutsSuspended } from "../common/keyboard-shortcuts.js";
import { isMac } from "../common/platform.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const INDIGO: Workspace = {
  slug: "indigo",
  displayName: "Indigo",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_indigo",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const OPTIONS: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 1200,
      default: true,
      selectable: true,
      netMonthlyCents: 1200,
      deltaCents: null,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    },
  ],
};

const REMOVED = { ok: true, value: { uid: "agt_woah", terminal: true } };

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

function created(agentUid: string, channelId = ""): EntryPointResult {
  return { ok: true, target: { channelId, cardId: null, cardKind: null, agentUid } };
}

function mountSidebar(props: Record<string, unknown>): void {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: createFixtureChatSidebarApi(),
      seedDirectory: [],
      companies: [INDIGO],
      // The host read the New Bot flag as on for Indigo, so "New bot" opens
      // the takeover. The takeover creates through `oncreatenewbot`; the "+"
      // modal's own create is a different function and is never used here.
      newBotCompanyUids: ["cmp_indigo"],
      oncreateagent: async (): Promise<EntryPointResult> => {
        throw new Error("the takeover must not use the modal's create");
      },
      loadClaudeProviderFlag: async () => ok(false),
      loadCloudProvisionOptions: async () => ok(OPTIONS),
      loadAgentStatus: async () => ({ ok: true, value: { setupState: { phase: "provisioning" } } }),
      tenantAccountId: ACCOUNT,
      botRemovalRetryMs: 0,
      botCreateReplayMs: 0,
      ...props,
    },
  });
}

async function openTakeover(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await settle();
  click('[data-testid="chat-create-new-bot"]');
  await settle();
}

async function typeName(value: string): Promise<void> {
  const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  name.value = value;
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

async function pressCreate(name: string): Promise<void> {
  await typeName(name);
  click('[data-testid="new-bot-continue-name"]');
  await settle();
  click('[data-testid="new-bot-create-submit"]');
  await settle();
}

/** Create a bot and reach its waiting screen. */
async function startBot(name: string): Promise<void> {
  await openTakeover();
  await pressCreate(name);
  expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain(`Waking up ${name}`);
}

async function cancelAndConfirm(): Promise<void> {
  click('[data-testid="new-bot-takeover-cancel"]');
  await settle();
  click('[data-testid="new-bot-cancel-remove"]');
  await settle();
}

function notice(): string {
  return q('[data-testid="new-bot-cancel-notice"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** The sidebar keeps its lists per signed-in account. */
const ACCOUNT = "acct_test";

function storageKey(key: string): string {
  return tenantStorageKey({ accountId: ACCOUNT, companyId: "all" }, key);
}

function stored(key: string): unknown {
  return JSON.parse(window.localStorage.getItem(storageKey(key)) ?? "[]");
}

/** A removal asks the server more than once, with a timer between requests. */
async function removalSettled(check: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await settle(2);
    check();
  });
}

beforeEach(() => {
  window.localStorage?.clear?.();
  resetWakingSessionStores();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="chat-create-modal"]').forEach((node) => node.remove());
  window.localStorage?.clear?.();
});

describe("Cancel while the create request is out", () => {
  it("never drags the person back to the bot they cancelled, and removes that bot", async () => {
    // Owner walkthrough 2026-10-02 (the bot was Woah): "I hit Cancel. It took
    // me back to 'Name' then I entered a diff name and before I could continue
    // it quickly took me back to the one I tried to Cancel."
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }));
    const removeAgent = vi.fn(async () => REMOVED);
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot, removeAgent, onbotremoved });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    expect(q('[data-testid="new-bot-creating"]')).toBeTruthy();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    // Back on a clean create screen, with one line saying what is happening.
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-step-1"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");
    expect(notice()).toBe("Cancelling Woah. Anything already set up for it will be removed.");
    expect(removeAgent).not.toHaveBeenCalled();

    await typeName("Second");

    // The first request finishes now: the bot exists on the server.
    finishCreate(created("agt_woah", "chn_woah"));
    await removalSettled(() => expect(notice()).toBe("Woah was removed."));

    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Second");
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
    expect(q('[data-conversation-id="ch:chn_woah"]')).toBeNull();

    // The bot that answer named was removed, and the person is told so.
    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    expect(notice()).toBe("Woah was removed.");
    expect(onbotremoved).toHaveBeenCalledWith("agt_woah");
    expect(stored(REMOVED_BOTS_STORAGE_KEY)).toEqual(["agt_woah"]);
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toEqual([]);
    // The channel an older server made for the bot is not removed with it,
    // so it stays off the list.
    expect(stored(BOT_SETUP_CHANNELS_STORAGE_KEY)).toEqual(["chn_woah"]);
  });

  it("says nothing was created when the cancelled request made no bot", async () => {
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }));
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    finishCreate({ ok: false, blocked: false, reason: "That name is taken." });
    await settle(12);

    expect(notice()).toBe("Woah was cancelled. Nothing was created.");
    expect(removeAgent).not.toHaveBeenCalled();
    // The failure of a request the person cancelled is not shown as an error.
    expect(q('[role="alert"]')).toBeNull();
    expect(q('[data-testid="new-bot-step-1"]')).toBeTruthy();
  });

  it("lets the person start another bot at once while the first is removed", async () => {
    const finishers: Array<(result: EntryPointResult) => void> = [];
    const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishers.push(resolve); }));
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    await pressCreate("Second");

    finishers[0]!(created("agt_woah"));
    await settle(12);
    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    expect(q('[data-testid="new-bot-creating"]')?.textContent).toContain("Second");

    finishers[1]!(created("agt_second"));
    await settle(12);
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Second");
    expect(q('[data-conversation-id="dm:agt_second"]')).toBeTruthy();
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
    expect(removeAgent).toHaveBeenCalledTimes(1);
  });
});

describe("The key a create is sent under (review A-C5)", () => {
  const NO_ANSWER: EntryPointResult = {
    ok: false,
    blocked: false,
    reason: "The request timed out.",
    outcomeUnknown: true,
  };
  const NAME_TAKEN: EntryPointResult = {
    ok: false,
    blocked: false,
    reason: "A bot with that name already exists in this company. Try a different name.",
  };

  /** The key each create request went out under, in order. */
  function keysSent(oncreatenewbot: { mock: { calls: unknown[][] } }): string[] {
    return oncreatenewbot.mock.calls.map((call) => (call[1] as CloudBotDraft).idempotencyKey ?? "");
  }

  function keysKept(): string[] {
    return (stored(CREATE_KEYS_STORAGE_KEY) as Array<{ key: string }>).map((entry) => entry.key);
  }

  function createError(): string {
    return q('[data-testid="new-bot-create-screen"] [role="alert"]')?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  it("sends the same key again when the first create got no answer, and picks up the bot it made", async () => {
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockResolvedValueOnce(created("agt_woah"));
    mountSidebar({ oncreatenewbot });
    await settle();
    await openTakeover();
    await pressCreate("Woah");

    // No answer: the person is not told the create failed, and not told a name is taken.
    expect(createError()).toBe(
      "We didn't hear back, so we can't tell if Woah was created. Try again to pick up where it left off.",
    );
    const [first] = keysSent(oncreatenewbot);
    expect(first).toBeTruthy();
    // The key is written down while the outcome is unknown.
    expect(keysKept()).toEqual([first]);

    click('[data-testid="new-bot-create-submit"]');
    await settle(12);

    expect(keysSent(oncreatenewbot)).toEqual([first, first]);
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Woah");
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeTruthy();
    // The server answered: the key is let go.
    expect(keysKept()).toEqual([]);
  });

  it("reads a create that threw as no answer, and keeps its key", async () => {
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(created("agt_woah"));
    mountSidebar({ oncreatenewbot });
    await settle();
    await openTakeover();
    await pressCreate("Woah");

    expect(createError()).toContain("we can't tell if Woah was created");
    expect(createError()).not.toContain("socket");
    click('[data-testid="new-bot-create-submit"]');
    await settle(12);

    const sent = keysSent(oncreatenewbot);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBe(sent[0]);
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy();
  });

  it("uses a new key once the server has answered", async () => {
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NAME_TAKEN)
      .mockResolvedValueOnce(created("agt_woah"));
    mountSidebar({ oncreatenewbot });
    await settle();
    await openTakeover();
    await pressCreate("Woah");

    // A refusal on the first try is the server's own word and is shown as it is.
    expect(createError()).toBe(NAME_TAKEN.reason);
    expect(keysKept()).toEqual([]);
    click('[data-testid="new-bot-create-submit"]');
    await settle(12);

    const sent = keysSent(oncreatenewbot);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBeTruthy();
    expect(sent[1]).not.toBe(sent[0]);
  });

  it("says the bot may already exist when the same create, sent again, is told the name is in use", async () => {
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockResolvedValueOnce(NAME_TAKEN);
    mountSidebar({ oncreatenewbot });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-create-submit"]');
    await settle(12);

    expect(createError()).toBe(
      "A bot with that name already exists in this company. It may be the one you just tried to create. Look in Settings, under Bots, before trying again.",
    );
  });

  it("on Cancel after no answer, sends the create again under its key and removes the bot the server names", async () => {
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockImplementationOnce(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }))
      .mockResolvedValueOnce(created("agt_woah"));
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(notice()).toBe("Cancelling Woah. Anything already set up for it will be removed.");

    // The request the person cancelled times out. The bot exists on the server.
    finishCreate(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe("Woah was removed."));

    const sent = keysSent(oncreatenewbot);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBe(sent[0]);
    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(keysKept()).toEqual([]);
  });

  it("on Cancel, never says nothing was created when no answer ever arrives", async () => {
    let failCreate!: (err: Error) => void;
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockImplementationOnce(() => new Promise<EntryPointResult>((_resolve, reject) => { failCreate = reject; }))
      .mockResolvedValue(NO_ANSWER);
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    failCreate(new Error("The network connection was lost."));
    await removalSettled(() =>
      expect(notice()).toBe(
        "We couldn't confirm whether Woah was created. If it shows up in your bots, remove it from Settings, under Bots.",
      ),
    );

    expect(notice()).not.toContain("Nothing was created");
    // Asked three more times, each under the first request's key.
    const sent = keysSent(oncreatenewbot);
    expect(sent).toHaveLength(4);
    expect(new Set(sent).size).toBe(1);
    expect(removeAgent).not.toHaveBeenCalled();
    // The key is kept: creating the same bot again picks up the first answer.
    expect(keysKept()).toEqual([sent[0]]);
    expect(q('[role="alert"]')).toBeNull();
  });

  it("on Cancel after no answer, does not take a refusal of the second request as nothing created", async () => {
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockImplementationOnce(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }))
      .mockResolvedValue(NAME_TAKEN);
    mountSidebar({ oncreatenewbot, removeAgent: vi.fn(async () => REMOVED) });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    finishCreate(NO_ANSWER);
    await removalSettled(() => expect(notice()).toContain("We couldn't confirm whether Woah was created."));

    expect(notice()).not.toContain("Nothing was created");
    // The server answered the second request: it is not asked a third time.
    expect(oncreatenewbot).toHaveBeenCalledTimes(2);
  });

  it("clears the line about an unconfirmed create when the takeover closes", async () => {
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockImplementationOnce(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }))
      .mockResolvedValue(NO_ANSWER);
    mountSidebar({ oncreatenewbot, removeAgent: vi.fn(async () => REMOVED) });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    finishCreate(NO_ANSWER);
    await removalSettled(() => expect(notice()).toContain("We couldn't confirm"));

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    await openTakeover();

    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(notice()).toBe("");
    // No row is made for a bot nobody can name.
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
  });
});

describe("Cancel for a bot that is starting", () => {
  it("sends the removal for that bot after the person confirms, and its sidebar row disappears", async () => {
    let finishRemoval!: (answer: unknown) => void;
    const removeAgent = vi.fn(() => new Promise<unknown>((resolve) => { finishRemoval = resolve; }));
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent, onbotremoved });
    await settle();
    await startBot("Nova");
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeTruthy();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    // Asked first. Nothing is sent until the person confirms.
    expect(q('[data-testid="new-bot-cancel-confirm"]')?.textContent).toContain("Nova will be removed from Indigo");
    expect(removeAgent).not.toHaveBeenCalled();

    click('[data-testid="new-bot-cancel-remove"]');
    await settle();

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_nova", undefined);
    // While the server works: one line, a clean create screen, and the row
    // still there, marked, because the bot still exists.
    expect(notice()).toBe("Removing Nova. This can take a minute.");
    expect(q('[data-testid="new-bot-step-1"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-row-removing-pill"]')?.textContent?.trim()).toBe("Removing");
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toMatchObject([{ agentUid: "agt_nova", phase: "removing" }]);

    finishRemoval({ ok: true, value: { terminal: true } });
    await settle(12);

    expect(notice()).toBe("Nova was removed.");
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(onbotremoved).toHaveBeenCalledWith("agt_nova");
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toEqual([]);
  });

  it("names the bot's running computer when the server asks for it", async () => {
    const answers: unknown[] = [
      { ok: false, reason: "error", code: "AGENTS_V2_BOX_PROTECTED", instanceId: "i-0abc1234def567890" },
      { ok: true, value: { terminal: false, setupState: { phase: "deprovisioning" } } },
      { ok: true, value: { terminal: true, setupState: { phase: "deprovisioned" } } },
    ];
    const removeAgent = vi.fn(async () => answers.shift());
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await removalSettled(() => expect(notice()).toBe("Nova was removed."));

    expect(removeAgent.mock.calls).toEqual([
      ["agt_nova", undefined],
      ["agt_nova", { confirmDestroyInstanceId: "i-0abc1234def567890" }],
      ["agt_nova", { confirmDestroyInstanceId: "i-0abc1234def567890" }],
    ]);
    expect(notice()).toBe("Nova was removed.");
  });

  it("says removal failed and offers Try again, and never shows the bot as removed", async () => {
    const removeAgent = vi.fn(async (): Promise<unknown> => ({ ok: false, reason: "error", code: "http-502" }));
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent, onbotremoved });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await removalSettled(() => expect(notice()).toContain("We couldn't remove Nova. It still exists."));

    expect(notice()).toBe("We couldn't remove Nova. It still exists. Try again Keep Nova");
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-row-removing-pill"]')?.textContent?.trim()).toBe("Not removed");
    expect(onbotremoved).not.toHaveBeenCalled();
    expect(stored(REMOVED_BOTS_STORAGE_KEY)).toEqual([]);
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toMatchObject([{ agentUid: "agt_nova", phase: "failed", problem: "error" }]);
    const requests = removeAgent.mock.calls.length;
    expect(requests).toBe(3);

    removeAgent.mockImplementation(async () => ({ ok: true, value: { terminal: true } }));
    click('[data-testid="new-bot-cancel-retry"]');
    await removalSettled(() => expect(notice()).toBe("Nova was removed."));

    expect(removeAgent).toHaveBeenCalledTimes(requests + 1);
    expect(notice()).toBe("Nova was removed.");
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(onbotremoved).toHaveBeenCalledWith("agt_nova");
  });

  it("keeps a bot that was not removed on the list after the takeover closes, and its row reopens the status", async () => {
    const removeAgent = vi.fn(async () => ({ ok: false, reason: "error", code: "http-403" }));
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await settle(12);

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(notice()).toBe(
      "Nova was not removed. Only an owner or admin of this company can remove a bot. Ask one of them to remove Nova. OK",
    );
    expect(q('[data-testid="new-bot-cancel-retry"]')).toBeNull();

    // Leave the takeover. The bot still exists, so it stays visible.
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    const row = q<HTMLButtonElement>('[data-conversation-id="dm:agt_nova"]')!;
    expect(row.textContent).toContain("Not removed");

    row.click();
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(notice()).toContain("Nova was not removed.");
  });

  it("puts a bot that was not removed back as a bot that is starting once the person accepts that", async () => {
    const removeAgent = vi.fn(async () => ({ ok: false, reason: "error", code: "http-403" }));
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent, onbotremoved });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await settle(12);
    expect(q('[data-testid="chat-row-removing-pill"]')?.textContent?.trim()).toBe("Not removed");

    click('[data-testid="new-bot-cancel-dismiss"]');
    await settle();

    // The bot exists and keeps starting, so it is shown that way again.
    expect(q('[data-testid="new-bot-cancel-notice"]')).toBeNull();
    expect(q('[data-testid="chat-row-removing-pill"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toEqual([]);
    expect(onbotremoved).not.toHaveBeenCalled();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
  });

  it("says removed when the server no longer has the bot (review A-I9)", async () => {
    // A 404 used to count as a failed request: three tries, then "We couldn't
    // remove Nova. It still exists." for a bot that was already gone.
    const removeAgent = vi.fn(async () => ({ ok: false, reason: "error", code: "http-404", status: 404 }));
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent, onbotremoved });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await removalSettled(() => expect(notice()).toBe("Nova was removed."));

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(onbotremoved).toHaveBeenCalledWith("agt_nova");
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(stored(REMOVED_BOTS_STORAGE_KEY)).toEqual(["agt_nova"]);
  });

  it("reads a 403 with a code of its own as not allowed, after one request (review A-I9)", async () => {
    const removeAgent = vi.fn(async () => ({ ok: false, reason: "error", code: "FORBIDDEN", status: 403 }));
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await removalSettled(() => expect(notice()).toContain("Nova was not removed."));

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(notice()).toBe(
      "Nova was not removed. Only an owner or admin of this company can remove a bot. Ask one of them to remove Nova. OK",
    );
  });

  it("does not call a removal the server is still carrying out a failure, and never restarts that bot (review A-I9)", async () => {
    // A teardown that outlasted the wait was reported as "It still exists",
    // and "Keep Nova" then started a waiting screen for a bot on its way out.
    const removeAgent = vi.fn(async () => ({ ok: true, value: { terminal: false, setupState: { phase: "deprovisioning" } } }));
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent, onbotremoved });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await vi.waitFor(async () => {
      await settle(2);
      expect(notice()).toContain("Nova is still being removed.");
    }, { timeout: 10_000, interval: 20 });

    expect(notice()).toBe("Nova is still being removed. This is taking longer than usual. Check again OK");
    expect(notice()).not.toContain("still exists");
    expect(q('[data-testid="new-bot-cancel-dismiss"]')?.textContent?.trim()).toBe("OK");
    expect(onbotremoved).not.toHaveBeenCalled();
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toMatchObject([{ agentUid: "agt_nova", phase: "failed", problem: "still-removing" }]);

    // Put away: the bot is not handed a waiting screen or a "waking" row.
    click('[data-testid="new-bot-cancel-dismiss"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-notice"]')).toBeNull();
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
  }, 15_000);

  it("clears a finished cancel when the takeover closes", async () => {
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");
    await cancelAndConfirm();
    await settle(12);
    expect(notice()).toBe("Nova was removed.");

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-cancel-notice"]')).toBeNull();
  });
});

describe("Cancel for a member who may not remove bots (review A-I8)", () => {
  it("does not offer removal, sends none, and leaves the bot starting", async () => {
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({
      companies: [{ ...INDIGO, role: "member" }],
      oncreatenewbot: async () => created("agt_nova"),
      removeAgent,
    });
    await settle();
    await startBot("Nova");

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    const dialog = q('[data-testid="new-bot-cancel-confirm"]')!;
    expect(dialog.textContent).toContain("You can't remove Nova");
    expect(dialog.textContent).toContain("Only an owner or admin of this company can remove a bot.");
    expect(q('[data-testid="new-bot-cancel-remove"]')).toBeNull();

    click('[data-testid="new-bot-cancel-leave"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(removeAgent).not.toHaveBeenCalled();
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toEqual([]);
  });

  it.each(["owner", "admin"])("still offers removal to an %s", async (role) => {
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ companies: [{ ...INDIGO, role }], oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')?.textContent).toContain("Nova will be removed from Indigo");
    expect(q('[data-testid="new-bot-cancel-remove"]')).toBeTruthy();
  });
});

describe("Leaving the waiting screen", () => {
  it("sends no removal and the bot keeps its sidebar row", async () => {
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), removeAgent });
    await settle();
    await startBot("Nova");

    const leave = q<HTMLButtonElement>('[data-testid="new-bot-waking-close"]')!;
    expect(leave.textContent?.trim()).toBe("Close and keep working");
    leave.click();
    await settle();

    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(removeAgent).not.toHaveBeenCalled();
    expect(q('[data-conversation-id="dm:agt_nova"]')?.textContent).toContain("Nova");
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(q('[data-testid="chat-row-removing-pill"]')).toBeNull();

    // Its row still reopens the waiting screen for the same bot.
    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
  });
});

describe("The app's shortcuts while the takeover is open (review A-C2)", () => {
  // This block replaces "A create that finishes after the takeover was closed
  // without Cancel", which asserted that a global shortcut closes the
  // takeover in the middle of a create. The review asked for the opposite:
  // the takeover is a modal dialog and holds the app's shortcuts while it is
  // open. What that test protected (the bot keeps its row when its answer
  // arrives late) is covered below, in "Bots that are starting outlive the
  // sidebar".
  it("holds every shortcut, in the middle of a create too, so none can close it", async () => {
    const newChat = vi.fn();
    const unregister = registerShortcuts([
      { id: "test.new-chat", keys: "Mod+N", label: "New chat", group: "Test", allowInInput: true, run: newChat },
    ]);
    try {
      let finishCreate!: (result: EntryPointResult) => void;
      const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }));
      mountSidebar({ oncreatenewbot, removeAgent: vi.fn(async () => REMOVED) });
      await settle();
      expect(shortcutsSuspended()).toBe(false);
      expect(runShortcut("test.new-chat")).toBe(true);
      newChat.mockClear();

      await openTakeover();
      await pressCreate("Nova");
      expect(q('[data-testid="new-bot-creating"]')).toBeTruthy();

      // From the keyboard, and from the menu: nothing fires.
      expect(shortcutsSuspended()).toBe(true);
      const mac = isMac();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "n", code: "KeyN", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true }),
      );
      expect(runShortcut("test.new-chat")).toBe(false);
      // The sidebar's own shortcut is held with the rest.
      expect(runShortcut("scope.personal")).toBe(false);
      await settle();
      expect(newChat).not.toHaveBeenCalled();
      expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
      expect(q('[data-testid="new-bot-creating"]')).toBeTruthy();

      // The create answers into a takeover that is still there.
      finishCreate(created("agt_nova"));
      await settle(12);
      expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");

      // Closing the takeover lets the shortcuts go.
      click('[data-testid="new-bot-waking-close"]');
      await settle();
      expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
      expect(shortcutsSuspended()).toBe(false);
      expect(runShortcut("test.new-chat")).toBe(true);
      expect(newChat).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});

describe("Bots that are starting outlive the sidebar (review A-C2)", () => {
  // The waiting screen is the only way to a new bot's brain sign-in. Its
  // session lived in the sidebar's memory, and the sidebar is rebuilt on a
  // company switch, when it is collapsed, and on restart.
  const APPROVAL_STATUS = {
    ok: true,
    value: {
      agent: { provider: "codex" },
      setupState: { phase: "waiting", steps: [{ name: "runtime", status: "done" }, { name: "codex-auth", status: "waiting" }] },
      pairing: { url: "https://auth.openai.com/codex/device", code: "TEST-CODE" },
    },
  };

  function wakingStored(): Array<Record<string, unknown>> {
    return stored(WAKING_BOTS_STORAGE_KEY) as Array<Record<string, unknown>>;
  }

  async function remount(props: Record<string, unknown>): Promise<void> {
    if (component) await unmount(component);
    component = null;
    mountSidebar(props);
    await settle();
  }

  it("gives a bot its row when its create answers after the sidebar was rebuilt", async () => {
    // "Mid-create the answer lands in a destroyed component: bot exists with
    // no row."
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }));
    mountSidebar({ oncreatenewbot, removeAgent: vi.fn(async () => REMOVED) });
    await settle();
    await openTakeover();
    await pressCreate("Nova");

    // The company scope changes: the host rebuilds the sidebar for it.
    await remount({ oncreatenewbot, tenantCompanyId: "cmp_indigo", scopeUid: "cmp_indigo" });
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();

    finishCreate(created("agt_nova"));
    await settle(12);

    expect(q('[data-conversation-id="dm:agt_nova"]')?.textContent).toContain("Nova");
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(wakingStored()).toMatchObject([{ agentUid: "agt_nova", name: "Nova", companyUid: "cmp_indigo", phase: "waking" }]);

    // Its row leads to its waiting screen.
    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
  });

  it("restores the row after a restart, and its screen reopens on the sign-in", async () => {
    mountSidebar({ oncreatenewbot: async () => created("agt_nova"), loadAgentStatus: async () => APPROVAL_STATUS });
    await settle();
    await startBot("Nova");
    expect(q('[data-testid="new-bot-codex-code"]')?.textContent).toBe("TEST-CODE");
    click('[data-testid="new-bot-waking-close"]');
    await settle();

    // The sign-in code and link are never written down.
    const everything = JSON.stringify({ ...window.localStorage });
    expect(everything).toContain("agt_nova");
    expect(everything).not.toContain("TEST-CODE");
    expect(everything).not.toContain("auth.openai.com");

    // Quit and start again: nothing is left in memory.
    if (component) await unmount(component);
    component = null;
    resetWakingSessionStores();
    const loadAgentStatus = vi.fn(async () => APPROVAL_STATUS);
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), loadAgentStatus });
    await settle();

    const row = q<HTMLButtonElement>('[data-conversation-id="dm:agt_nova"]')!;
    expect(row.textContent).toContain("Nova");
    expect(row.querySelector('[data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    // The server was asked once about the bot read back from storage.
    expect(loadAgentStatus).toHaveBeenCalledTimes(1);
    expect(loadAgentStatus).toHaveBeenCalledWith("agt_nova", "codex");

    row.click();
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
    expect(q('[data-testid="new-bot-approval"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-codex-code"]')?.textContent).toBe("TEST-CODE");
    expect(q('[data-testid="new-bot-approval-open"]')?.textContent).toBe("Continue with Codex");
  });

  function seedWaking(entries: Array<Record<string, unknown>>): void {
    resetWakingSessionStores();
    window.localStorage.setItem(storageKey(WAKING_BOTS_STORAGE_KEY), JSON.stringify(entries));
  }
  const SEEDED = { agentUid: "agt_nova", channelId: "", companyUid: "cmp_indigo", name: "Nova", brain: "codex", estimateMs: 180_000, phase: "waking" };

  it.each([
    ["was removed", { ok: false, reason: "error", code: "http-404", status: 404 }],
    ["is out of reach for this person", { ok: false, reason: "error", code: "FORBIDDEN", status: 403 }],
    ["is being removed", { ok: true, value: { setupState: { phase: "deprovisioning" } } }],
  ])("forgets a bot read back from storage that %s", async (_label, answer) => {
    seedWaking([{ ...SEEDED, startedAt: Date.now() - 60_000 }]);
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), loadAgentStatus: async () => answer });
    await settle(12);
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(wakingStored()).toEqual([]);
  });

  it("forgets a bot that can chat and was already asked for its first message, and keeps one that was not asked yet", async () => {
    const CHAT_READY = { ok: true, value: { setupState: { phase: "ready", steps: [] } } };
    seedWaking([
      { ...SEEDED, startedAt: Date.now() - 60_000, chatReadyAt: Date.now() - 30_000, helloAskedAt: Date.now() - 29_000 },
      { ...SEEDED, agentUid: "agt_later", name: "Later", startedAt: Date.now() - 60_000 },
    ]);
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), loadAgentStatus: async () => CHAT_READY });
    await settle(12);
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    // Not asked for its hello yet: opening its screen is what asks.
    expect(q('[data-conversation-id="dm:agt_later"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(wakingStored().map((entry) => entry.agentUid)).toEqual(["agt_later"]);
  });

  it("keeps a bot whose status could not be read, and forgets one that has been starting for a day", async () => {
    seedWaking([
      { ...SEEDED, startedAt: Date.now() - 60_000 },
      { ...SEEDED, agentUid: "agt_old", name: "Old", startedAt: Date.now() - 25 * 60 * 60_000 },
    ]);
    mountSidebar({
      oncreatenewbot: async () => created("agt_other"),
      loadAgentStatus: async () => ({ ok: false, reason: "error", code: "http-503" }),
    });
    await settle(12);
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(q('[data-conversation-id="dm:agt_old"]')).toBeNull();
  });

  it("shows a starting bot only in its own company when the sidebar is scoped to one", async () => {
    seedWaking([{ ...SEEDED, startedAt: Date.now() - 60_000 }]);
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), tenantCompanyId: "cmp_elsewhere", scopeUid: "cmp_elsewhere" });
    await settle(12);
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();

    await remount({ oncreatenewbot: async () => created("agt_other"), tenantCompanyId: "cmp_indigo", scopeUid: "cmp_indigo" });
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    // Still on the account's list while the other company was in view.
    expect(wakingStored().map((entry) => entry.agentUid)).toEqual(["agt_nova"]);
  });
});

describe("More than one bot starting (review A-I1)", () => {
  const byName = async (_companyUid: string, draft: { name: string }): Promise<EntryPointResult> =>
    created(draft.name === "Nova" ? "agt_nova" : "agt_second");

  it("New bot opens the create screen, not the bot that is starting, and Cancel there removes nothing", async () => {
    // "New bot" used to open the starting bot's screen, where the header
    // Cancel removed that bot.
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot: byName, removeAgent });
    await settle();
    await startBot("Nova");
    click('[data-testid="new-bot-waking-close"]');
    await settle();

    await openTakeover();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-testid="new-bot-step-1"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')).toBeNull();
    expect(removeAgent).not.toHaveBeenCalled();
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
  });

  it("keeps a row for each bot, and each row opens its own bot", async () => {
    // One slot held "the" starting bot, so a second create replaced the first.
    mountSidebar({ oncreatenewbot: byName, removeAgent: vi.fn(async () => REMOVED) });
    await settle();
    await startBot("Nova");
    click('[data-testid="new-bot-waking-close"]');
    await settle();
    await startBot("Second");
    click('[data-testid="new-bot-waking-close"]');
    await settle();

    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect(q('[data-conversation-id="dm:agt_second"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
    expect((stored(WAKING_BOTS_STORAGE_KEY) as Array<{ agentUid: string }>).map((entry) => entry.agentUid).sort()).toEqual([
      "agt_nova",
      "agt_second",
    ]);

    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
    click('[data-testid="new-bot-waking-close"]');
    await settle();
    click('[data-conversation-id="dm:agt_second"]');
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Second");
  });

  it("removes only the bot whose screen Cancel was pressed on", async () => {
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot: byName, removeAgent });
    await settle();
    await startBot("Nova");
    click('[data-testid="new-bot-waking-close"]');
    await settle();
    await startBot("Second");
    await cancelAndConfirm();
    await removalSettled(() => expect(notice()).toBe("Second was removed."));

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_second", undefined);
    expect(q('[data-conversation-id="dm:agt_second"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_nova"] [data-testid="chat-waking-bot-ring"]')).toBeTruthy();
  });
});

describe("A removal the app was in the middle of", () => {
  it("is asked again when the app starts", async () => {
    window.localStorage.setItem(
      storageKey(OPEN_BOT_REMOVALS_STORAGE_KEY),
      JSON.stringify([
        { name: "Nova", companyUid: "cmp_indigo", agentUid: "agt_nova", channelId: "", phase: "removing", hadRow: true, startedAt: 1, problem: null },
      ]),
    );
    const removeAgent = vi.fn(async () => REMOVED);
    const onbotremoved = vi.fn();
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), removeAgent, onbotremoved });
    await removalSettled(() => expect(onbotremoved).toHaveBeenCalledWith("agt_nova"));

    expect(removeAgent).toHaveBeenCalledWith("agt_nova", undefined);
    expect(onbotremoved).toHaveBeenCalledWith("agt_nova");
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toEqual([]);
    expect(stored(REMOVED_BOTS_STORAGE_KEY)).toEqual(["agt_nova"]);
  });
});
