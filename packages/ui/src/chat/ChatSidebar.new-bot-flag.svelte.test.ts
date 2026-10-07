// @vitest-environment happy-dom

/**
 * The New Bot takeover follows the host's flag answer as it changes.
 *
 * `newBotCompanyUids` is empty until the host has read the
 * `agents.desktop-agent-creation` flag for the person's companies, and the
 * sidebar tells the host which companies to read. These tests change props
 * on a mounted sidebar, so they live in a runes test file.
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { takePendingChannelOpen } from "./open-target.js";
import { resetWakingSessionStores } from "./create-bot/waking-sessions.js";
import { createBotFlowDoor } from "../shell/lazy-doors.js";

// The create window loads its bot flow on demand on the rail; load it first
// so the flow paints in the same tick these tests click into it.
beforeAll(async () => {
  await createBotFlowDoor.load();
});

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function workspace(slug: string, name: string, uid: string): Workspace {
  return {
    slug,
    displayName: name,
    kind: "company",
    state: "synced",
    cloudUid: uid,
    bucketName: null,
    hasLocalFolder: true,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
  };
}

const INDIGO = workspace("indigo", "Indigo", "cmp_indigo");
const ACME = workspace("acme", "Acme", "cmp_acme");

const seedDirectory = [
  {
    channelId: "hq-desktop",
    name: "hq-desktop",
    scope: "company",
    lastActivityAt: new Date().toISOString(),
  },
];

const okTarget: EntryPointResult = {
  ok: true,
  target: { channelId: "setup", cardId: "card_create_company_2", cardKind: null },
};

const CLOUD_PROVISION_OPTIONS: AgentProvisionOptionsView = {
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

const BASE_PROPS = {
  seedDirectory,
  loadClaudeProviderFlag: async () => ok(false),
  loadCloudProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
};

async function settle(times = 6): Promise<void> {
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

beforeEach(() => {
  window.localStorage?.clear?.();
  takePendingChannelOpen();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="chat-create-modal"], [data-testid="chat-scope-menu"]')
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
  takePendingChannelOpen();
});

/**
 * "New bot" asks the name, then "Where should it live?", in the full-window
 * takeover. The flag decides what Cloud opens: the takeover's own create
 * screen, or the "+" window's bot flow in the takeover shell.
 */
async function chooseKind(kind: "cloud" | "local", name = "Nova"): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  expect(input).toBeTruthy();
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="new-bot-continue-name"]');
  await settle();
  expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  click(`[data-testid="new-bot-choice-${kind}"]`);
  await settle();
}

describe("ChatSidebar New Bot takeover: the host's flag answer", () => {
  it("stays on the '+' window's flow until the host has an answer, then offers the takeover", async () => {
    const props = $state({
      ...BASE_PROPS,
      api: createFixtureChatSidebarApi(),
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async () => okTarget,
      // Empty until the host's flag read comes back.
      newBotCompanyUids: [] as string[],
    });
    component = mount(ChatSidebar, { target: host, props });
    await settle();
    click('[data-testid="chat-new-message"]');
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    // The "+" window's own cloud flow, on the shared step screens in its shell.
    expect(q('[data-testid="new-bot-sunrise-flow"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();

    // The answer arrives: Indigo has the flag. Close the bot flow first.
    expect(q('[data-testid="chat-create-modal"]')?.getAttribute("data-sunrise")).toBe("true");
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    props.newBotCompanyUids = ["cmp_indigo"];
    await settle();
    // On the rail, New bot is on the "+" menu, which closes after each pick.
    document.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("goes back to the '+' window's flow when the flag is read as off", async () => {
    const props = $state({
      ...BASE_PROPS,
      api: createFixtureChatSidebarApi(),
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async () => okTarget,
      newBotCompanyUids: ["cmp_indigo"] as string[],
    });
    component = mount(ChatSidebar, { target: host, props });
    await settle();
    // A later read says off, or could not be had.
    props.newBotCompanyUids = [];
    await settle();
    click('[data-testid="chat-new-message"]');
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    // The "+" window's own cloud flow, on the shared step screens in its shell.
    expect(q('[data-testid="new-bot-sunrise-flow"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
  });

  it("keeps an open takeover's create screen when a later read comes back off", async () => {
    const props = $state({
      ...BASE_PROPS,
      api: createFixtureChatSidebarApi(),
      companies: [INDIGO],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async () => okTarget,
      newBotCompanyUids: ["cmp_indigo"] as string[],
    });
    component = mount(ChatSidebar, { target: host, props });
    await settle();
    click('[data-testid="chat-new-message"]');
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();

    // The person is part-way through. The screen is not taken away.
    props.newBotCompanyUids = [];
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();

    // Once it is closed, the next "New bot" follows the new answer.
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    // Opened from the "+" menu, so Cancel goes back to the "+" button. It
    // does not open a create window the person never had open.
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    expect(document.activeElement?.getAttribute("data-testid")).toBe("chat-new-message");
    // On the rail, New bot is on the "+" menu, which closes after each pick.
    document.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    // The "+" window's own cloud flow, on the shared step screens in its shell.
    expect(q('[data-testid="new-bot-sunrise-flow"]')).toBeTruthy();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
  });

  it("keeps the list it started with when the takeover is opened from a bot's row (round 4, item 5)", async () => {
    // A cancelled bot that could not be removed keeps a row. Its row opens
    // the takeover on the create screen. That way in took no copy of the
    // list, so a later flag read changed the companies under the person.
    resetWakingSessionStores();
    const removeAgent = vi.fn(async () => ({ ok: false, reason: "error", code: "http-403" }));
    const props = $state({
      ...BASE_PROPS,
      api: createFixtureChatSidebarApi(),
      seedDirectory: [],
      companies: [{ ...INDIGO, role: "owner" }, { ...ACME, role: "owner" }] as Workspace[],
      oncreateagent: async () => okTarget,
      oncreatenewbot: async (): Promise<EntryPointResult> => ({
        ok: true,
        target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_nova" },
      }),
      loadAgentStatus: async () => ({ ok: true, value: { setupState: { phase: "provisioning" } } }),
      removeAgent,
      tenantAccountId: "acct_test",
      botRemovalRetryMs: 0,
      newBotCompanyUids: ["cmp_indigo", "cmp_acme"] as string[],
    });
    component = mount(ChatSidebar, { target: host, props });
    await settle();

    // The name was given before Cloud: on to the company step.
    const nameBot = async (): Promise<void> => {
      click('[data-testid="new-bot-continue-brain"]');
      await settle();
    };
    const offered = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="new-bot-company-grid"] [role="radio"]')].map(
        (company) => company.dataset.companyUid ?? "",
      );

    // Make Nova, cancel it, and the removal is refused: Nova keeps a row.
    click('[data-testid="chat-new-message"]');
    await settle();
    click('[data-testid="chat-create-menu-agent"]');
    await settle();
    await chooseKind("cloud");
    await nameBot();
    await vi.waitFor(() =>
      expect(q<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')?.disabled).toBe(false),
    );
    click('[data-testid="new-bot-create-submit"]');
    await vi.waitFor(() => expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy());
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="new-bot-cancel-remove"]');
    await vi.waitFor(() => expect(removeAgent).toHaveBeenCalled());
    await settle(12);
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();

    // Open the takeover from Nova's row: it starts on the name.
    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    expect(q('[data-testid="new-bot-name-screen"]')).toBeTruthy();

    // A later read says Indigo is off. The open takeover keeps both companies.
    props.newBotCompanyUids = ["cmp_acme"];
    await settle();
    const first = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    first.value = "Nova";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    await nameBot();
    expect(offered()).toEqual(["cmp_indigo", "cmp_acme"]);

    // Once it is closed, the next way in follows the new answer.
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-conversation-id="dm:agt_nova"]');
    await settle();
    const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    name.value = "Nova";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    click('[data-testid="new-bot-continue-name"]');
    await settle();
    // One company: no company step, and nothing but Acme to create in.
    expect(q('[data-testid="new-bot-continue-brain"]')).toBeNull();
    expect(q('[data-testid="new-bot-company-grid"]')).toBeNull();
  });

  it("tells the host which companies a cloud bot can be made in, on change and when the '+' modal opens", async () => {
    const onagentcompanies = vi.fn();
    const props = $state({
      ...BASE_PROPS,
      api: createFixtureChatSidebarApi(),
      companies: [INDIGO] as Workspace[],
      oncreateagent: async () => okTarget,
      onagentcompanies,
    });
    component = mount(ChatSidebar, { target: host, props });
    await settle();
    expect(onagentcompanies).toHaveBeenCalledTimes(1);
    expect(onagentcompanies).toHaveBeenLastCalledWith(["cmp_indigo"]);

    // Nothing changed: the host is not told again.
    await settle(10);
    expect(onagentcompanies).toHaveBeenCalledTimes(1);

    // The list grows.
    props.companies = [INDIGO, ACME];
    await settle();
    expect(onagentcompanies).toHaveBeenCalledTimes(2);
    expect(onagentcompanies).toHaveBeenLastCalledWith(["cmp_indigo", "cmp_acme"]);

    // The "+" modal opens: the host is told again, so an answer older than
    // its five minutes is read again before the person reaches "New bot".
    click('[data-testid="chat-new-message"]');
    await settle();
    expect(onagentcompanies).toHaveBeenCalledTimes(3);
    expect(onagentcompanies).toHaveBeenLastCalledWith(["cmp_indigo", "cmp_acme"]);
  });
});
