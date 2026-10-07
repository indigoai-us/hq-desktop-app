// @vitest-environment happy-dom

/**
 * Owner (2026-10-05): "new bot process should ask if you want cloud or local
 * first. also i would like to use the beautiful sunrise design for the local
 * bot creation as well". Owner (2026-10-07): the name comes first, then the
 * Cloud or Local question.
 *
 * Every "New bot" entry opens the full-window takeover on the name, then
 * "Where should <Name> live?", even when no company has the takeover's own
 * cloud create. Local (and Cloud in companies the takeover does not list)
 * opens the "+" window's bot flow inside the same takeover shell, with Home
 * set to the answer and the name carried in; Back from its first step
 * returns to the question with the name kept.
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

/** The takeover's first step: name the bot and continue to "Where should it live?". */
async function nameBot(name = "Nova"): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  click('[data-testid="new-bot-continue-name"]');
  await settle();
}

/** "+" → New bot → the name. */
async function newBotNamed(name = "Nova"): Promise<void> {
  await pressNewBot();
  await nameBot(name);
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

describe("New bot asks the name, then Cloud or Local", () => {
  it("opens the takeover on the name, then the choice, even when no company has the takeover, as long as a local bot is possible", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await pressNewBot();

    expect(q('[data-testid="new-bot-takeover"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-name-screen"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    await nameBot("Nova");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
    // No cloud bot can be made here: Cloud is shown off, with why.
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Cloud bots");
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.disabled).toBe(false);
  });

  it("Local opens the local bot flow in the takeover shell, on the coding tool, with the name carried in", async () => {
    const oncreatebot = localBot();
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatebot, oncreateagent, newBotCompanyUids: [] });
    await settle();
    await newBotNamed("Nova");
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
    // The name was asked: the local flow opens on its one step, the coding tool.
    const flow = card?.querySelector<HTMLElement>('[data-testid="chat-create-bot-step"]');
    expect(flow?.getAttribute("data-home")).toBe("local");
    expect(flow?.getAttribute("data-step")).toBe("home");
    expect(card?.querySelector('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    expect(card?.querySelector('[data-testid="new-bot-name"]')).toBeNull();
    expect(card?.querySelector('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    expect(card?.querySelector("#new-bot-takeover-title")?.textContent).toBe("Pick the coding tool.");
    // "Where does it run?" is not asked again.
    expect(q('[data-testid="create-bot-home-step"]')).toBeNull();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    // The plain window card, the old crumbs and the preview rail are not drawn.
    expect(shell!.querySelector(".create-card")).toBeNull();
    expect(shell!.querySelector(".flow-crumbs")).toBeNull();
    expect(shell!.querySelector('[data-testid^="create-bot-crumb-"]')).toBeNull();
    expect(shell!.querySelector('[data-testid="bot-preview-card"]')).toBeNull();
  });

  it("the local flow still creates through the host's local create, under the name given first", async () => {
    const oncreatebot = localBot();
    mountSidebar({ companies: [INDIGO], oncreatebot, newBotCompanyUids: [] });
    await settle();
    await newBotNamed("Dr Love");
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
    click('[data-testid="chat-bot-create"]');
    await settle(12);
    expect(oncreatebot).toHaveBeenCalledOnce();
    const [input, extras] = oncreatebot.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ name: "dr-love" });
    expect(String(input.kickoff)).toContain("avatar");
    expect(extras).toEqual({ displayName: "Dr Love" });
    expect(sunriseFlow()).toBeNull();
  });

  it("Back from the local flow's first step returns to the choice, with the name kept", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await newBotNamed("Nova");
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    const back = q<HTMLButtonElement>('[data-testid="create-bot-back"]')!;
    expect(back.textContent).toContain("Back");
    back.click();
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
    // And Back again reaches the name, still typed.
    click('[data-testid="new-bot-back-to-name"]');
    await settle();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Nova");
  });

  it("Cancel in the shell closes the local flow, and the next New bot starts with no name", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await newBotNamed("Nova");
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    click('[data-testid="new-bot-takeover-cancel"]');
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    await pressNewBot();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("");
  });

  it("Cloud with no takeover company opens the '+' window's cloud flow in the shell, with Home set to Cloud and the name carried in", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreatebot: localBot(),
      oncreateagent,
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: [],
    });
    await settle();
    await newBotNamed("Polar");
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();

    expect(q('[data-testid="new-bot-takeover"]')).toBeNull();
    expect(sunriseFlow()).toBeTruthy();
    // Home is Cloud; with two companies the first cloud step picks the company.
    const flow = q('[data-testid="chat-create-bot-step"]');
    expect(flow?.getAttribute("data-home")).toBe("cloud");
    expect(flow?.getAttribute("data-step")).toBe("home");
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeTruthy();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Polar");
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-cloud-details-step"]')).toBeTruthy();
    expect(q<HTMLInputElement>('[data-testid="chat-bot-name"]')?.value).toBe("Polar");
  });

  it("Cloud with a takeover company opens the takeover's own create screen with the name", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await newBotNamed("Polar");
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    click('[data-testid="new-bot-choice-cloud"]');
    await settle();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Polar");
    expect(sunriseFlow()).toBeNull();
  });

  it("Create a cloud bot instead on the local coding tool step opens the takeover's cloud screen with the name, the choice behind Back", async () => {
    mountSidebar({
      companies: [INDIGO],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: ["cmp_indigo"],
    });
    await settle();
    await newBotNamed("Nova");
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step")).toBe("home");
    click('[data-testid="create-bot-switch-cloud"]');
    await settle();
    expect(sunriseFlow()).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    click('[data-testid="new-bot-back-to-choice"]');
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
  });

  it("Create a cloud bot instead with no takeover company opens the window's cloud flow fresh, with the name", async () => {
    mountSidebar({
      companies: [INDIGO, ACME],
      oncreatebot: localBot(),
      oncreateagent: vi.fn(async () => okTarget),
      oncreatenewbot: vi.fn(async () => okTarget),
      newBotCompanyUids: [],
    });
    await settle();
    await newBotNamed("Nova");
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
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
  });

  it("no Create a cloud bot instead when Cloud cannot be picked", async () => {
    mountSidebar({ companies: [INDIGO], oncreatebot: localBot(), newBotCompanyUids: [] });
    await settle();
    await newBotNamed();
    click('[data-testid="new-bot-choice-local"]');
    await settle();
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-home")).toBe("local");
    expect(q('[data-testid="chat-create-bot-step"]')?.getAttribute("data-step")).toBe("home");
    expect(q('[data-testid="create-bot-switch-cloud"]')).toBeNull();
  });

  it("the host's New bot entry (Team page, Settings, palette) asks the same questions", async () => {
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
    expect(q('[data-testid="new-bot-name-screen"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    await nameBot();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
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
