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
      botCreateLookupMs: 0,
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

  // ── Cancel never sends a create (review A-C5, second round) ─────────────
  // When the create's answer is lost, Cancel reads the company's bots and
  // looks for the draft's handle. It must not send the create again: a first
  // request that never reached the server would then make the bot.

  /** A row as the company roster returns it. */
  function rosterRow(agentUid: string, slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { agentUid, uid: agentUid, companyUid: "cmp_indigo", name: slug, displayName: slug, slug, setupPhase: "provisioning", ...extra };
  }

  function rosterAnswer(...rows: Array<Record<string, unknown>>): unknown {
    return { ok: true, value: { agents: rows } };
  }

  /**
   * Press Create bot for Woah and Cancel while the request is out. Returns
   * the create mock and the way to end the request.
   */
  async function cancelWhileCreating(props: Record<string, unknown>): Promise<{
    oncreatenewbot: ReturnType<typeof vi.fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>>;
    finish: (result: EntryPointResult) => void;
    fail: (err: Error) => void;
  }> {
    let finish!: (result: EntryPointResult) => void;
    let fail!: (err: Error) => void;
    const oncreatenewbot = vi.fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>(
      () => new Promise<EntryPointResult>((resolve, reject) => { finish = resolve; fail = reject; }),
    );
    mountSidebar({ oncreatenewbot, ...props });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(notice()).toBe("Cancelling Woah. Anything already set up for it will be removed.");
    return { oncreatenewbot, finish, fail };
  }

  const UNCONFIRMED =
    "We couldn't confirm whether Woah was created. If it shows up in your bots, remove it from Settings, under Bots.";

  it.each([
    {
      branch: "an answer with no known outcome, and the bot is found",
      end: "unknown",
      after: [rosterRow("agt_woah", "woah")],
      line: "Woah was removed.",
    },
    {
      branch: "an answer with no known outcome, and the bot is never found",
      end: "unknown",
      after: [],
      line: UNCONFIRMED,
    },
    {
      branch: "a request that timed out and threw",
      end: "timeout",
      after: [],
      line: UNCONFIRMED,
    },
    {
      branch: "a refusal",
      end: "refusal",
      after: [],
      line: "Woah was cancelled. Nothing was created.",
    },
  ] as const)("Cancel sends no create after $branch", async ({ end, after, line }) => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      // The list read when Create bot was pressed: one older bot.
      .mockResolvedValueOnce(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" })))
      .mockResolvedValue(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" }), ...after));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish, fail } = await cancelWhileCreating({ loadCompanyBots, removeAgent });

    if (end === "unknown") finish(NO_ANSWER);
    else if (end === "timeout") fail(new Error("The request timed out."));
    else finish(NAME_TAKEN);
    await removalSettled(() => expect(notice()).toBe(line));
    await settle(12);

    // The one create is the press itself. Cancel sent none, in any branch.
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(q('[role="alert"]')).toBeNull();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
  });

  it("on Cancel after no answer, reads the company's bots and removes the one with the draft's handle", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" })))
      // The first request is still running at the first look.
      .mockResolvedValueOnce(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" })))
      .mockResolvedValue(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" }), rosterRow("agt_woah", "woah")));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish } = await cancelWhileCreating({ loadCompanyBots, removeAgent });
    // The baseline was read at the press, for this company, before any answer.
    expect(loadCompanyBots).toHaveBeenCalledTimes(1);
    expect(loadCompanyBots).toHaveBeenCalledWith("cmp_indigo");

    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe("Woah was removed."));

    expect(loadCompanyBots).toHaveBeenCalledTimes(3);
    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
    // The outcome is known: the key is let go.
    expect(keysKept()).toEqual([]);
  });

  it("on Cancel, never says nothing was created when the bot is not found, and keeps the key", async () => {
    const loadCompanyBots = vi.fn(async (): Promise<unknown> => rosterAnswer(rosterRow("agt_old", "scout")));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, fail } = await cancelWhileCreating({ loadCompanyBots, removeAgent });

    fail(new Error("The network connection was lost."));
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));

    expect(notice()).not.toContain("Nothing was created");
    // One read at the press, then three looks.
    expect(loadCompanyBots).toHaveBeenCalledTimes(4);
    expect(removeAgent).not.toHaveBeenCalled();
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    // The key is kept: pressing Create bot again for the same bot picks up the first answer.
    expect(keysKept()).toEqual(keysSent(oncreatenewbot));
  });

  it("on Cancel, never removes a bot that already had the handle before the create was sent", async () => {
    // Somebody's older bot is called woah. This create was refused for it,
    // and its answer was lost. That bot must stay.
    const loadCompanyBots = vi.fn(async (): Promise<unknown> => rosterAnswer(rosterRow("agt_theirs", "woah", { setupPhase: "ready" })));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish } = await cancelWhileCreating({ loadCompanyBots, removeAgent });

    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));
    await settle(12);

    expect(removeAgent).not.toHaveBeenCalled();
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    // Looking again would not change it: one read at the press, one look.
    expect(loadCompanyBots).toHaveBeenCalledTimes(2);
  });

  it("on Cancel, never removes a bot found by its handle when the list from before the create could not be read", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, reason: "network", code: "timeout", message: "timed out" })
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish } = await cancelWhileCreating({ loadCompanyBots, removeAgent });

    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));
    await settle(12);

    expect(removeAgent).not.toHaveBeenCalled();
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
  });

  it("on Cancel, never removes a bot found by its handle that the server says another person created", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const loadAgentStatus = vi.fn(async () => ({
      ok: true,
      value: { agent: { uid: "agt_woah", ownerUid: "prs_grace" }, setupState: { phase: "provisioning" } },
    }));
    const removeAgent = vi.fn(async () => REMOVED);
    const { finish } = await cancelWhileCreating({
      loadCompanyBots,
      loadAgentStatus,
      removeAgent,
      self: { uid: "prs_ada", displayName: "Ada" },
    });

    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));
    await settle(12);

    expect(loadAgentStatus).toHaveBeenCalledWith("agt_woah");
    expect(removeAgent).not.toHaveBeenCalled();
  });

  it("on Cancel, a person who may not remove bots is told who can, and no removal is sent", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish } = await cancelWhileCreating({
      loadCompanyBots,
      removeAgent,
      companies: [{ ...INDIGO, role: "member" }],
      isAdmin: false,
    });

    finish(NO_ANSWER);
    await removalSettled(() =>
      expect(notice()).toContain(
        "Woah was not removed. Only an owner or admin of this company can remove a bot. Ask one of them to remove Woah.",
      ),
    );
    await settle(12);

    expect(removeAgent).not.toHaveBeenCalled();
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    // The bot exists and stays: putting the line away gives it its row back.
    click('[data-testid="new-bot-cancel-dismiss"]');
    await settle();
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeTruthy();
  });

  it("without a way to read the company's bots, says it could not confirm, at once", async () => {
    const removeAgent = vi.fn(async () => REMOVED);
    const { oncreatenewbot, finish } = await cancelWhileCreating({ removeAgent });

    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));

    expect(removeAgent).not.toHaveBeenCalled();
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
  });

  it("clears the line about an unconfirmed create when the takeover closes", async () => {
    const { finish } = await cancelWhileCreating({ removeAgent: vi.fn(async () => REMOVED) });
    finish(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe(UNCONFIRMED));

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    await openTakeover();

    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(notice()).toBe("");
    // No row is made for a bot nobody can name.
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
  });

  it("compares a second press of the same draft with the list from before the first", async () => {
    // First press: no answer, and the bot is not on the list yet when the
    // app looks. The person presses Create bot again (same key) and cancels
    // that one. The bot is not on the list from before the first press, so
    // it is this create's.
    let finishSecond!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockImplementationOnce(() => new Promise<EntryPointResult>((resolve) => { finishSecond = resolve; }));
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      // The list at the first press, and the look after its lost answer.
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, loadCompanyBots, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(q('[data-testid="new-bot-create-submit"]')).toBeTruthy());
    click('[data-testid="new-bot-create-submit"]');
    await settle();
    // The second press reads no new list: the first one's is kept with the key.
    expect(loadCompanyBots).toHaveBeenCalledTimes(2);
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();

    finishSecond(NO_ANSWER);
    await removalSettled(() => expect(notice()).toBe("Woah was removed."));

    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    // Two presses, two creates, under one key. Cancel added none.
    expect(oncreatenewbot).toHaveBeenCalledTimes(2);
    expect(new Set(keysSent(oncreatenewbot)).size).toBe(1);
  });

  // ── A create with no answer is looked for before it can be sent again ───
  // Review G-2: the server checks the name before it looks at the key, so a
  // create sent again while the first is still running is told "name already
  // exists" for good. The bot existed with no row, no hello and no sign-in.

  it("holds Create bot after no answer, looks for the bot, and takes it up without a second create", async () => {
    let answerLook!: (roster: unknown) => void;
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" })))
      .mockImplementationOnce(() => new Promise<unknown>((resolve) => { answerLook = resolve; }));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValue(NO_ANSWER);
    mountSidebar({ oncreatenewbot, loadCompanyBots });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(loadCompanyBots).toHaveBeenCalledTimes(2));
    await settle();

    // The look is out. The person is told, and there is no Create bot to press.
    const status = q('[data-testid="new-bot-creating-status"]');
    expect(status?.textContent?.trim()).toBe("Checking whether Woah was created...");
    expect(status?.getAttribute("data-state")).toBe("checking");
    expect(q('[data-testid="new-bot-create-submit"]')).toBeNull();
    expect(q('[role="alert"]')).toBeNull();

    // The first request did make the bot.
    answerLook(rosterAnswer(rosterRow("agt_old", "scout", { setupPhase: "ready" }), rosterRow("agt_woah", "woah")));
    await vi.waitFor(() => expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Woah"));

    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeTruthy();
    // One create in all: nothing was sent again.
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(keysKept()).toEqual([]);
  });

  it("lets the person send it again once the look found no bot", async () => {
    const loadCompanyBots = vi.fn(async (): Promise<unknown> => rosterAnswer(rosterRow("agt_old", "scout")));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockResolvedValueOnce(created("agt_woah"));
    mountSidebar({ oncreatenewbot, loadCompanyBots });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(createError()).toContain("We didn't hear back"));

    // One look, not three: the person is not kept waiting to try again.
    expect(loadCompanyBots).toHaveBeenCalledTimes(2);
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="new-bot-creating-status"]')).toBeNull();

    click('[data-testid="new-bot-create-submit"]');
    await vi.waitFor(() => expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy());
    const sent = keysSent(oncreatenewbot);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("takes the bot up when the create, sent again, is told the name is in use", async () => {
    // The second request arrived while the first was still running.
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer())
      // The look after the first press, and the first look after the second.
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockResolvedValueOnce(NAME_TAKEN);
    mountSidebar({ oncreatenewbot, loadCompanyBots });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(q('[data-testid="new-bot-create-submit"]')).toBeTruthy());
    click('[data-testid="new-bot-create-submit"]');

    await vi.waitFor(() => expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Woah"));
    // The bot has its row, as a bot named by the create's own answer would.
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeTruthy();
    expect(q('[role="alert"]')).toBeNull();
    expect(oncreatenewbot).toHaveBeenCalledTimes(2);
    expect(loadCompanyBots).toHaveBeenCalledTimes(4);
    expect(keysKept()).toEqual([]);
  });

  it("does not take up a bot that already had the handle before the create was sent", async () => {
    // Somebody's older bot is called woah. Both requests were refused for it.
    const loadCompanyBots = vi.fn(async (): Promise<unknown> => rosterAnswer(rosterRow("agt_theirs", "woah", { setupPhase: "ready" })));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValueOnce(NO_ANSWER)
      .mockResolvedValueOnce(NAME_TAKEN);
    mountSidebar({ oncreatenewbot, loadCompanyBots });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(createError()).toContain("We didn't hear back"));
    click('[data-testid="new-bot-create-submit"]');

    await vi.waitFor(() =>
      expect(createError()).toBe(
        "A bot with that name already exists in this company. It may be the one you just tried to create. Look in Settings, under Bots, before trying again.",
      ),
    );
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_theirs"]')).toBeNull();
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeNull();
  });

  it("does not take up a bot the server says another person created", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const loadAgentStatus = vi.fn(async () => ({
      ok: true,
      value: { agent: { uid: "agt_woah", ownerUid: "prs_grace" }, setupState: { phase: "provisioning" } },
    }));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValue(NO_ANSWER);
    mountSidebar({ oncreatenewbot, loadCompanyBots, loadAgentStatus, self: { uid: "prs_ada", displayName: "Ada" } });
    await settle();
    await openTakeover();
    await pressCreate("Woah");

    await vi.waitFor(() => expect(createError()).toContain("We didn't hear back"));
    expect(loadAgentStatus).toHaveBeenCalledWith("agt_woah");
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
  });

  it("Cancel while the bot is being looked for settles the same way, and sends no create", async () => {
    const loadCompanyBots = vi
      .fn<(companyUid: string) => Promise<unknown>>()
      .mockResolvedValueOnce(rosterAnswer())
      .mockResolvedValue(rosterAnswer(rosterRow("agt_woah", "woah")));
    const oncreatenewbot = vi
      .fn<(companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>>()
      .mockResolvedValue(NO_ANSWER);
    const removeAgent = vi.fn(async () => REMOVED);
    // A long wait before each look, so Cancel lands while the first is pending.
    mountSidebar({ oncreatenewbot, loadCompanyBots, removeAgent, botCreateLookupMs: 40 });
    await settle();
    await openTakeover();
    await pressCreate("Woah");
    await vi.waitFor(() => expect(q('[data-testid="new-bot-creating-status"]')?.getAttribute("data-state")).toBe("checking"));

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(notice()).toBe("Cancelling Woah. Anything already set up for it will be removed.");
    await removalSettled(() => expect(notice()).toBe("Woah was removed."));

    expect(removeAgent).toHaveBeenCalledTimes(1);
    expect(removeAgent).toHaveBeenCalledWith("agt_woah", undefined);
    expect(oncreatenewbot).toHaveBeenCalledTimes(1);
    // The cancelled bot is not taken up as a bot that is starting.
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
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

describe("A removal that is still going when the sidebar goes away (review item 3)", () => {
  const WORKING = { ok: true, value: { setupState: { phase: "deprovisioning" } } };

  function seedRemoval(): void {
    window.localStorage.setItem(
      storageKey(OPEN_BOT_REMOVALS_STORAGE_KEY),
      JSON.stringify([
        { name: "Nova", companyUid: "cmp_indigo", agentUid: "agt_nova", channelId: "", phase: "removing", hadRow: true, startedAt: 1, problem: null },
      ]),
    );
  }

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("stops asking when the sidebar is destroyed, and keeps the removal written down", async () => {
    seedRemoval();
    const removeAgent = vi.fn(async () => WORKING);
    mountSidebar({ oncreatenewbot: async () => created("agt_other"), removeAgent, botRemovalRetryMs: 5 });
    await vi.waitFor(() => expect(removeAgent.mock.calls.length).toBeGreaterThanOrEqual(3));

    await unmount(component!);
    component = null;
    const asked = removeAgent.mock.calls.length;
    await wait(60);

    // Not one more request from a sidebar that is gone.
    expect(removeAgent.mock.calls.length).toBeLessThanOrEqual(asked + 1);
    const settledAt = removeAgent.mock.calls.length;
    await wait(60);
    expect(removeAgent.mock.calls.length).toBe(settledAt);
    // The removal is still under way: the next sidebar picks it up.
    expect(stored(OPEN_BOT_REMOVALS_STORAGE_KEY)).toMatchObject([{ agentUid: "agt_nova", phase: "removing" }]);
  });

  it("runs one loop per bot after the sidebar is rebuilt, not one per rebuild", async () => {
    seedRemoval();
    let asking = 0;
    let mostAtOnce = 0;
    const removeAgent = vi.fn(async () => {
      asking += 1;
      mostAtOnce = Math.max(mostAtOnce, asking);
      await wait(3);
      asking -= 1;
      return WORKING;
    });
    for (let rebuild = 0; rebuild < 4; rebuild += 1) {
      if (component) await unmount(component);
      resetWakingSessionStores();
      mountSidebar({ oncreatenewbot: async () => created("agt_other"), removeAgent, botRemovalRetryMs: 5 });
      await vi.waitFor(() => expect(removeAgent.mock.calls.length).toBeGreaterThanOrEqual(rebuild + 1));
      await wait(12);
    }

    // The last sidebar's loop is the only one asking. Four loops would
    // overlap and ask about four times as often.
    const before = removeAgent.mock.calls.length;
    await wait(80);
    const perLoop = removeAgent.mock.calls.length - before;
    expect(perLoop).toBeGreaterThan(0);
    expect(perLoop).toBeLessThanOrEqual(12);
    expect(mostAtOnce).toBeLessThanOrEqual(2);
  });

  it("asks nothing while the window is hidden, and goes on when it is shown again", async () => {
    seedRemoval();
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "hidden");
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    try {
      const removeAgent = vi.fn(async () => WORKING);
      mountSidebar({ oncreatenewbot: async () => created("agt_other"), removeAgent, botRemovalRetryMs: 5 });
      await vi.waitFor(() => expect(removeAgent.mock.calls.length).toBeGreaterThanOrEqual(2));

      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await wait(20);
      const whileHidden = removeAgent.mock.calls.length;
      await wait(60);
      expect(removeAgent.mock.calls.length).toBe(whileHidden);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(removeAgent.mock.calls.length).toBeGreaterThan(whileHidden));
    } finally {
      delete (document as unknown as Record<string, unknown>).hidden;
      if (original) Object.defineProperty(Document.prototype, "hidden", original);
    }
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
