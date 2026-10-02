// @vitest-environment happy-dom

/**
 * Cancel in the new cloud bot flow, through the shell (US-016): the removal
 * goes out through the platform adapter, and the shell drops what it kept for
 * the bot. The adapter here is a fake. No server is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { takePendingChannelOpen } from "../chat/open-target.js";
import type { ConversationRow } from "../chat/sidebar-model.js";

const NEW_CLOUD_BOTS_STORAGE_KEY = "hq.chat.newCloudBots.v1";

const COMPANY_ROW: ConversationRow = {
  id: "ch:chn_acme",
  kind: "channel",
  title: "acme",
  channelId: "chn_acme",
  channelScope: "company",
  companyUid: "cmp_acme",
  isCompanyHome: true,
} as ConversationRow;

const CLOUD_PROVISION_OPTIONS: AgentProvisionOptionsView = {
  defaultInstanceType: "t4g.medium",
  catalogVersion: "test-catalog",
  options: [
    {
      key: "basic",
      productName: "Basic",
      instanceType: "t4g.medium",
      listCents: 5000,
      default: true,
      selectable: true,
      netMonthlyCents: 4200,
      deltaCents: 4200,
      unavailableReason: null,
      notBilled: false,
      lanes: 1,
      workers: 1,
    },
  ],
};

const ACME_WORKSPACE = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: null,
  hasLocalFolder: true,
  localPath: null,
  membershipStatus: "active",
  role: "owner",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
} as const;

function adapter(
  messaging: Record<string, unknown>,
  agents: Record<string, unknown>,
): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      // The Team tab answers with where the company's create card lives.
      runCompanyTabAction: async () =>
        ok({ cardId: "team:spend", actionId: "add_agent", state: "open", channelId: "chn_acme", focusCardId: "create_agent" }),
      ...messaging,
    },
    identity: {
      listAvatarPacks: async () => ok({ packs: [], expiresAt: Date.now() + 60_000 }),
      updateAgentProfile: async () => ok({}),
      hasFeature: async () => ok(false),
    },
    agents: {
      getProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
      getStatus: async () => ok({ setupState: { phase: "provisioning" } }),
      retryProvisioning: async () => ok({}),
      ...agents,
    },
    meetings: { listUpcoming: async () => ok([]) },
    calls: {
      contractVersion: "hq-meet/1",
      discoverOffice: async (companyUid: string) => ok({ companyUid, people: [], observedAt: Date.now() }),
    },
    settings: {
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, hqFolderPath: "/tmp/HQ" }),
    },
    shell: { detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }) },
    appShell: { logToFile: async () => ok(undefined) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 10): Promise<void> {
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

function mountApp(adapterValue: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: adapterValue,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
      initialRow: COMPANY_ROW,
      companies: [ACME_WORKSPACE],
    },
  });
}

async function pressCreate(name: string): Promise<void> {
  await vi.waitFor(() => expect(q('[data-testid="chat-new-message"]')).toBeTruthy());
  click('[data-testid="chat-new-message"]');
  await settle();
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="new-bot-continue-name"]');
  await settle();
  await vi.waitFor(() =>
    expect(q<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')?.disabled).toBe(false),
  );
  click('[data-testid="new-bot-create-submit"]');
  await settle();
}

function newCloudBots(): string[] {
  return JSON.parse(window.localStorage.getItem(NEW_CLOUD_BOTS_STORAGE_KEY) ?? "[]") as string[];
}

beforeEach(() => {
  window.localStorage?.clear?.();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  takePendingChannelOpen();
  window.localStorage?.clear?.();
});

describe("DesktopApp: Cancel in the new bot flow", () => {
  it("removes a bot whose create answered after Cancel, through the adapter, and forgets it", async () => {
    let finishCreate!: (value: unknown) => void;
    const runCardAction = vi.fn(() => new Promise((resolve) => { finishCreate = resolve; }));
    const deprovision = vi.fn(async () => ok({ uid: "agt_woah", terminal: true }));
    mountApp(adapter({ runCardAction }, { deprovision }));

    await pressCreate("Woah");
    await vi.waitFor(() => expect(runCardAction).toHaveBeenCalledOnce());
    expect(q('[data-testid="new-bot-creating"]')).toBeTruthy();

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-step-1"]')).toBeTruthy();
    expect(deprovision).not.toHaveBeenCalled();

    // The create answers after Cancel: the bot exists.
    finishCreate(ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_woah" }));

    await vi.waitFor(() => expect(deprovision).toHaveBeenCalledWith("agt_woah", undefined));
    await vi.waitFor(() =>
      expect(q('[data-testid="new-bot-cancel-notice"]')?.textContent).toContain("Woah was removed."),
    );
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeNull();
    expect(q('[data-conversation-id="dm:agt_woah"]')).toBeNull();
    // The shell had noted the new bot when the create answered. It is forgotten.
    expect(newCloudBots()).not.toContain("agt_woah");
  }, 30_000);

  it("removes a bot that is starting after the person confirms, and forgets it", async () => {
    const runCardAction = vi.fn(async () =>
      ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_nova" }),
    );
    const deprovision = vi.fn(async () => ok({ uid: "agt_nova", terminal: true }));
    mountApp(adapter({ runCardAction }, { deprovision }));

    await pressCreate("Nova");
    await vi.waitFor(() =>
      expect(q('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova"),
    );
    expect(newCloudBots()).toContain("agt_nova");

    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-cancel-confirm"]')?.textContent).toContain("Nova will be removed from Acme");
    expect(deprovision).not.toHaveBeenCalled();
    click('[data-testid="new-bot-cancel-remove"]');

    await vi.waitFor(() => expect(deprovision).toHaveBeenCalledWith("agt_nova", undefined));
    await vi.waitFor(() =>
      expect(q('[data-testid="new-bot-cancel-notice"]')?.textContent).toContain("Nova was removed."),
    );
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeNull();
    expect(newCloudBots()).not.toContain("agt_nova");
  }, 30_000);

  it("leaving the waiting screen sends no removal and keeps the bot", async () => {
    const runCardAction = vi.fn(async () =>
      ok({ cardId: "create_agent", actionId: "create", state: "done", agentUid: "agt_nova" }),
    );
    const deprovision = vi.fn(async () => ok({ uid: "agt_nova", terminal: true }));
    mountApp(adapter({ runCardAction }, { deprovision }));

    await pressCreate("Nova");
    await vi.waitFor(() => expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy());
    click('[data-testid="new-bot-waking-close"]');
    await settle();

    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(deprovision).not.toHaveBeenCalled();
    expect(newCloudBots()).toContain("agt_nova");
    expect(q('[data-conversation-id="dm:agt_nova"]')).toBeTruthy();
  }, 30_000);
});
