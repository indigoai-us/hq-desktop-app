// @vitest-environment happy-dom

/**
 * The full-window New Bot flow offers Claude only when the host's Claude
 * provider flag is on (review A-C1). The sidebar hands the takeover the same
 * flag reader it hands the "+" modal's create, so the two flows agree.
 */
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { createBotFlowDoor } from "../shell/lazy-doors.js";

// The create window loads its bot flow on demand on the rail; load it first
// so the flow paints in the same tick these tests click into it.
beforeAll(async () => {
  await createBotFlowDoor.load();
});

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

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

async function openBrainStep(props: Record<string, unknown>): Promise<void> {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: createFixtureChatSidebarApi(),
      seedDirectory: [],
      companies: [INDIGO],
      newBotCompanyUids: ["cmp_indigo"],
      // The "+" modal's own create. The takeover never uses it.
      oncreateagent: async (): Promise<EntryPointResult> => {
        throw new Error("the takeover must not use the modal's create");
      },
      loadCloudProvisionOptions: async () => ok(OPTIONS),
      tenantAccountId: "acct_test",
      // Claude is the brain signed in on this computer.
      botRuntimeReady: { claude: true, codex: false, grok: false },
      ...props,
    },
  });
  await settle();
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await settle();
  q<HTMLButtonElement>('[data-testid="chat-create-menu-agent"]')!.click();
  await settle();
  const name = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  name.value = "Nova";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
  await settle();
}

function brains(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>("input[name='new-bot-brain']")].map(
    (brain) => `${brain.value}${brain.checked ? "*" : ""}`,
  );
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

describe("New Bot takeover: Claude follows the provider flag", () => {
  it("creates with Codex, never Claude, for a company without the provider", async () => {
    const oncreatenewbot = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: true,
        target: { channelId: "", cardId: null, cardKind: null, agentUid: "agt_nova" },
      }),
    );
    const loadClaudeProviderFlag = vi.fn(async () => ok(false));
    await openBrainStep({ oncreatenewbot, loadClaudeProviderFlag });

    expect(loadClaudeProviderFlag).toHaveBeenCalled();
    expect(brains()).toEqual(["codex*", "grok"]);
    q<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')!.click();
    await settle();
    expect(oncreatenewbot).toHaveBeenCalledWith("cmp_indigo", expect.objectContaining({ runtime: "codex" }));
  });

  it("offers Claude when the provider is on, read through the same reader as the modal's create", async () => {
    const loadClaudeProviderFlag = vi.fn(async () => ok(true));
    await openBrainStep({
      oncreatenewbot: async (): Promise<EntryPointResult> => ({ ok: false, blocked: false, reason: "" }),
      loadClaudeProviderFlag,
    });

    expect(brains()).toEqual(["codex", "claude*", "grok"]);
  });
});
