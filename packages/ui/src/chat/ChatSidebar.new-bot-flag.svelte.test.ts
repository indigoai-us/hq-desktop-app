// @vitest-environment happy-dom

/**
 * The New Bot takeover follows the host's flag answer as it changes.
 *
 * `newBotCompanyUids` is empty until the host has read the
 * `agents.desktop-agent-creation` flag for the person's companies, and the
 * sidebar tells the host which companies to read. These tests change props
 * on a mounted sidebar, so they live in a runes test file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { takePendingChannelOpen } from "./open-target.js";

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

describe("ChatSidebar New Bot takeover: the host's flag answer", () => {
  it("stays on the in-modal flow until the host has an answer, then offers the takeover", async () => {
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
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();

    // The answer arrives: Indigo has the flag.
    click('[data-testid="chat-create-back"]');
    await settle();
    props.newBotCompanyUids = ["cmp_indigo"];
    await settle();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("goes back to the in-modal flow when the flag is read as off", async () => {
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
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
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
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();

    // The person is part-way through. The screen is not taken away.
    props.newBotCompanyUids = [];
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();

    // Once it is closed, the next "New bot" follows the new answer.
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
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
