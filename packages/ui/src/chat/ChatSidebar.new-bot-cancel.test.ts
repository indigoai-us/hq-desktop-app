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
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import {
  OPEN_BOT_REMOVALS_STORAGE_KEY,
  REMOVED_BOTS_STORAGE_KEY,
} from "./create-bot/cancel-model.js";
import { BOT_SETUP_CHANNELS_STORAGE_KEY } from "./sidebar-model.js";
import { tenantStorageKey } from "../identity/tenant-storage.js";

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

describe("A create that finishes after the takeover was closed without Cancel", () => {
  it("keeps the bot starting in the sidebar and leaves an open create screen alone", async () => {
    let finishCreate!: (result: EntryPointResult) => void;
    const oncreatenewbot = vi.fn(() => new Promise<EntryPointResult>((resolve) => { finishCreate = resolve; }));
    const removeAgent = vi.fn(async () => REMOVED);
    mountSidebar({ oncreatenewbot, removeAgent });
    await settle();
    await openTakeover();
    await pressCreate("Nova");

    // The "+" list opens over the flow (a keyboard shortcut does this). That
    // closes the takeover. It is not Cancel.
    host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    await typeName("Second");

    finishCreate(created("agt_nova"));
    await settle(12);

    // The person keeps the screen they are on.
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Second");
    // The bot was not cancelled: it keeps starting and has its row.
    expect(removeAgent).not.toHaveBeenCalled();
    expect(q('[data-conversation-id="dm:agt_nova"]')?.textContent).toContain("Nova");
    expect(q('[data-testid="chat-waking-bot-ring"]')).toBeTruthy();
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
