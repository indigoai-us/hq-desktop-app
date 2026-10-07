// @vitest-environment happy-dom

/**
 * Owner (2026-10-05): "new bot process should ask if you want cloud or local
 * first. also i would like to use the beautiful sunrise design for the local
 * bot creation as well".
 *
 * Every "New bot" entry opens the full-window takeover on a "Cloud or
 * Local?" question, even when no company has the takeover's own cloud
 * create. Local (and Cloud in companies the takeover does not list) opens
 * the "+" window's bot flow inside the same takeover shell, with Home set
 * to the answer; Back from its first step returns to the question.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type AgentProvisionOptionsView } from "@hq/platform";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";
import { createBotFlowDoor } from "../shell/lazy-doors.js";
import { takePendingChannelOpen } from "./open-target.js";

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

const okTarget: EntryPointResult = {
  ok: true,
  target: { channelId: "setup", cardId: null, cardKind: null },
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

const localBot = () =>
  vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));

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

function mountSidebar(props: Record<string, unknown>): void {
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: createFixtureChatSidebarApi(),
      seedDirectory: [],
      loadClaudeProviderFlag: async () => ok(false),
      loadCloudProvisionOptions: async () => ok(CLOUD_PROVISION_OPTIONS),
      ...props,
    },
  });
}

/** The rail's "+" menu, then New bot. */
async function pressNewBot(): Promise<void> {
  click('[data-testid="chat-new-message"]');
  await settle();
  click('[data-testid="chat-create-menu-agent"]');
  await settle();
}

/** The "+" window's bot step, worn in the takeover shell. */
function sunriseFlow(): HTMLElement | null {
  return q('[data-testid="chat-create-modal"][data-sunrise="true"]');
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
    .querySelectorAll('[data-testid="chat-create-modal"], [data-testid="new-bot-takeover"]')
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
  takePendingChannelOpen();
});

describe("New bot asks Cloud or Local first", () => {
  it("opens the takeover's choice even when no company has the takeover, as long as a local bot is possible", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await pressNewBot();

    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    // No cloud bot can be made here: Cloud is shown off, with why.
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Cloud bots");
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.disabled).toBe(false);
  });

  it("Local opens the local bot flow in the takeover shell, with Home set to Local", async () => {
    const oncreatebot = localBot();
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatebot, oncreateagent, newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();

    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    const shell = sunriseFlow();
    expect(shell, "the bot flow wears the takeover shell").toBeTruthy();
    expect(shell!.classList.contains("new-bot-takeover")).toBe(true);
    expect(shell!.style.getPropertyValue("--new-bot-wallpaper")).toContain("url(");
    expect(shell!.querySelector(".new-bot-takeover-shade")).toBeTruthy();
    expect(shell!.querySelector(".new-bot-takeover-wordmark")?.textContent).toBe("HQ");
    const card = shell!.querySelector(".new-bot-takeover-card.new-bot-takeover-card--flow.new-bot-takeover-card--steps");
    // Owner (2026-10-06): "use the same design as cloud bot creation". The
    // local flow is the cloud flow's step screens: name first.
    const flow = card?.querySelector<HTMLElement>('[data-testid="chat-create-bot-step"]');
    expect(flow?.getAttribute("data-home")).toBe("local");
    expect(flow?.getAttribute("data-step")).toBe("details");
    expect(card?.querySelector('[data-testid="new-bot-progress"]')).toBeTruthy();
    expect(card?.querySelector('[data-testid="create-bot-details-step"]')).toBeTruthy();
    expect(card?.querySelector("#new-bot-takeover-title")?.textContent).toContain("Enter a");
    // The plain window card, the old crumbs and the preview rail are not drawn.
    expect(shell!.querySelector(".create-card")).toBeNull();
    expect(shell!.querySelector(".flow-crumbs")).toBeNull();
    expect(shell!.querySelector('[data-testid^="create-bot-crumb-"]')).toBeNull();
    expect(shell!.querySelector('[data-testid="bot-preview-card"]')).toBeNull();

    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
    click('[data-testid="create-bot-next"]');
    await settle();
    // "Where does it run?" is not asked again; the coding tool is its own step.
    expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
  });

  it("the local flow still creates through the host's local create", async () => {
    const oncreatebot = localBot();
    mountSidebar({ companies: [INDIGO], oncreatebot, newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    click('[data-testid="chat-bot-create"]');
    await settle(12);
    expect(oncreatebot).toHaveBeenCalledOnce();
    expect(sunriseFlow()).toBeNull();
  });

  it("Back from the local flow's first step returns to the choice", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    const back = q<HTMLButtonElement>('[data-testid="create-bot-back"]')!;
    expect(back.textContent).toContain("Back");
    back.click();
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  });

  it("Cancel in the shell closes the local flow", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
  });

  it("Cloud with no takeover company opens the '+' window's cloud flow in the shell, with Home set to Cloud", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreatebot: localBot(),
      oncreateagent,
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: [],
    });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();

    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(sunriseFlow()).toBeTruthy();
    // Home is Cloud; with two companies the first cloud step picks the company.
    const flow = q('[data-testid="chat-create-bot-step"]');
    expect(flow?.getAttribute("data-home")).toBe("cloud");
    expect(flow?.getAttribute("data-step")).toBe("home");
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeTruthy();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
  });

  it("Cloud with a takeover company opens the takeover's own create screen", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await pressNewBot();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(sunriseFlow()).toBeNull();
  });

  it("Create a cloud bot instead on the local name step opens the takeover's cloud screen, the choice behind Back", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step")).toBe("details");
    click('[data-testid="create-bot-switch-cloud"]');
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    click('[data-testid="new-bot-back-to-choice"]');
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  });

  it("Create a cloud bot instead with no takeover company opens the window's cloud flow fresh", async () => {
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: [],
    });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    click('[data-testid="create-bot-switch-cloud"]');
    await settle(12);
    expect(sunriseFlow()).toBeTruthy();
    // Not the local steps any more: the cloud flow, with Home on Cloud, from
    // its first step (the company picker, two companies here).
    const flow = q('[data-testid="chat-create-bot-step"]');
    expect(flow?.getAttribute("data-home")).toBe("cloud");
    expect(flow?.getAttribute("data-step")).toBe("home");
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeTruthy();
  });

  it("no Create a cloud bot instead when Cloud cannot be picked", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step")).toBe("details");
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
  });

  it("the host's New bot entry (Team page, Settings, palette) asks the same question", async () => {
    let actions: { openNewAgent: (companyUid?: string | null) => void } | null = null;
    mountSidebar({
      companies: [INDIGO],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      onactions: (next: typeof actions) => {
        actions = next;
      },
    });
    await settle();
    expect(actions).toBeTruthy();
    actions!.openNewAgent("cmp_indigo");
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    expect(sunriseFlow()).toBeTruthy();
  });

  it("with no way to make any bot, New bot keeps the '+' window's own step", async () => {
    mountSidebar({ companies: [INDIGO], newBotCompanyUids: [] });
    await settle();
    await pressNewBot();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
  });
});
