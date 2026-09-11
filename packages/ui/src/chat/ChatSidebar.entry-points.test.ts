// @vitest-environment happy-dom

/**
 * Lifecycle entry points offered by the sidebar: "New company" / "New bot"
 * rows in the "+" modal and a "New company" row in the company switcher. The
 * sidebar never runs the server action itself — it calls the host callbacks
 * and either closes (success) or shows the reason inline (blocked).
 *
 * Every AI teammate is a bot. One "New bot" row opens the create-bot flow
 * (kind → home → details); the Home step picks Local (this Mac) or Cloud
 * (company bot, today's create-agent team action).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import type { Workspace } from "./workspaces.js";
import type { EntryPointResult } from "./lifecycle-entry-points.js";

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

/** Kind step → Home step (Blank is preselected). */
async function toHomeStep(): Promise<void> {
  click('[data-testid="chat-create-new-bot"]');
  await settle();
  expect(q('[data-testid="create-bot-kind-step"]')).toBeTruthy();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
}

function mountSidebar(props: Record<string, unknown>): void {
  component = mount(ChatSidebar, {
    target: host,
    props: { api: createFixtureChatSidebarApi(), seedDirectory, ...props },
  });
}

async function openModal(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await settle();
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
  document
    .querySelectorAll('[data-testid="chat-create-modal"], [data-testid="chat-scope-menu"]')
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
});

describe("ChatSidebar lifecycle entry points", () => {
  it("hides the rows when the host provides no entry-point callbacks", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-entry-points"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-company"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-bot"]')).toBeNull();
  });

  it("New company calls the host and closes the modal on success", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-company"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("New company");
    row!.click();
    await settle(10);
    expect(oncreatecompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
    // Focus returns to the "+" control.
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "chat-new-message",
    );
  });

  it("New bot with only Cloud available opens on Cloud and creates in the one company", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("New bot");
    expect(row?.textContent).toContain("Indigo");
    await toHomeStep();
    // No local runtime on this host → Local is disabled and Cloud is preselected.
    const local = q<HTMLButtonElement>('[data-testid="chat-bot-where-local"]');
    const cloud = q<HTMLButtonElement>('[data-testid="chat-bot-where-cloud"]');
    expect(local?.disabled).toBe(true);
    expect(cloud?.getAttribute("aria-checked")).toBe("true");
    // One company → no picker; Cloud ends here (details live in the company channel).
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeNull();
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    const create = q<HTMLButtonElement>('[data-testid="chat-bot-create"]');
    expect(create?.textContent).toContain("Continue in Indigo");
    create!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo");
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("offers a company the directory knows before the workspace list refreshes", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const directoryRow = {
      channelId: "chn_ramen_bae",
      name: "ramen-bae",
      scope: "company",
      type: "chat",
      companyUid: "cmp_ramen_bae",
      companyName: "Ramen Bae",
      lastActivityAt: new Date().toISOString(),
      unreadCount: 0,
      memberCount: 2,
    };
    const api = {
      ...createFixtureChatSidebarApi(),
      fetchChannelDirectory: async () => ({
        contractVersion: 2,
        snapshot: true,
        cursor: "entry-points-cursor",
        cursorExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        rows: [directoryRow],
      }),
    } as unknown as ReturnType<typeof createFixtureChatSidebarApi>;
    mountSidebar({ api, companies: [], oncreateagent, seedDirectory: [directoryRow] });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Ramen Bae");
    await toHomeStep();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_ramen_bae");
  });

  it("Cloud with several companies shows the company picker, keyboard included, and Create uses the pick", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent, oncreatebot });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row?.textContent).toContain("Runs on this Mac or in the cloud");
    await toHomeStep();
    // Both hosts available → Local is the default, the picker is hidden, and Next leads to details.
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-where-local"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeNull();
    expect(q('[data-testid="create-bot-next"]')).toBeTruthy();
    click('[data-testid="chat-bot-where-cloud"]');
    await settle();
    expect(oncreateagent).not.toHaveBeenCalled();
    expect(q('[data-testid="create-bot-next"]')).toBeNull();
    const picker = q('[data-testid="chat-create-agent-picker"]');
    expect(picker?.getAttribute("role")).toBe("listbox");
    expect(picker?.getAttribute("aria-label")).toBe("Add a bot to which company?");
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-create-agent-company"]',
      ),
    );
    expect(options.map((o) => o.dataset.company)).toEqual(["cmp_indigo", "cmp_acme"]);
    // Company tiles use the app-wide monogram helper (`initialsFor`), the same
    // two-letter mark the sidebar rows and scope switcher show.
    expect(options.map((o) => o.textContent?.replace(/\s+/g, " ").trim())).toEqual(["IN Indigo", "AC Acme"]);
    // First company is preselected.
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    // Arrow keys move between the company rows.
    options[0]!.focus();
    picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    options[1]!.click();
    await settle();
    expect(oncreateagent).not.toHaveBeenCalled();
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true"]);
    expect(q('[data-testid="chat-bot-create"]')?.textContent).toContain("Continue in Acme");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme");
    expect(oncreatebot).not.toHaveBeenCalled();
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("shows a blocked reason inline in the bot step and keeps the modal open", async () => {
    const oncreateagent = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: false,
        reason: "Only owners can add agents.",
        blocked: true,
      }),
    );
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent });
    await settle();
    await openModal();
    await toHomeStep();
    document
      .querySelector<HTMLButtonElement>('[data-company="cmp_acme"]')!
      .click();
    await settle();
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme");
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
    const error = q('[data-testid="chat-create-entry-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Only owners can add agents.");
  });

  it("the company switcher ends with a New company row that runs the same flow", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreatecompany });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!.click();
    await settle();
    const menu = q('[data-testid="chat-scope-menu"]');
    expect(menu).toBeTruthy();
    const rows = Array.from(menu!.querySelectorAll("button"));
    const last = rows.at(-1);
    expect(last?.getAttribute("data-testid")).toBe("chat-scope-new-company");
    expect(last?.getAttribute("role")).toBe("menuitem");
    expect(last?.textContent).toContain("New company");
    last!.click();
    await settle(10);
    expect(oncreatecompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-scope-menu"]')).toBeNull();
  });

  it("the switcher row shows a failure reason inline and stays open", async () => {
    const oncreatecompany = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: false,
        reason: "Cloud is unreachable",
        blocked: false,
      }),
    );
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!.click();
    await settle();
    q<HTMLButtonElement>('[data-testid="chat-scope-new-company"]')!.click();
    await settle(10);
    expect(q('[data-testid="chat-scope-menu"]')).toBeTruthy();
    expect(
      q('[data-testid="chat-scope-new-company-error"]')?.textContent,
    ).toContain("Cloud is unreachable");
  });

  it("omits the switcher row without a host callback", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    host.querySelector<HTMLButtonElement>('[data-testid="chat-scope-pill"]')!.click();
    await settle();
    expect(q('[data-testid="chat-scope-menu"]')).toBeTruthy();
    expect(q('[data-testid="chat-scope-new-company"]')).toBeNull();
  });
});

describe("ChatSidebar 'New bot' entry point (local bots)", () => {
  it("hides the row when the host has no local bots", async () => {
    mountSidebar({ companies: [INDIGO] });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-new-bot"]')).toBeNull();
  });

  it("walks kind → home → details and submits name, runtime, and pre-approval to the host", async () => {
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "assistant" }));
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    const plus = q<HTMLButtonElement>('[data-testid="chat-new-message"]');
    expect(plus?.getAttribute("aria-label")).toBe("New message, channel, company, or bot");
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Runs on this Mac");
    await toHomeStep();
    // Only a local host here → Local is checked and Cloud is not offered at all.
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-where-local"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q('[data-testid="chat-bot-where-cloud"]')).toBeNull();
    click('[data-testid="chat-bot-runtime-grok"]');
    await settle();
    click('[data-testid="create-bot-next"]');
    await settle();
    expect(q('[data-testid="create-bot-details-step"]')).toBeTruthy();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    expect(name.value).toBe("assistant");
    expect(q('[data-testid="bot-preview-name"]')?.textContent).toBe("assistant");
    expect(q('[data-testid="bot-preview-thinks"]')?.textContent).toBe("thinks with Grok");
    click('[data-testid="chat-bot-create"]');
    await settle(10);
    expect(oncreatebot).toHaveBeenCalledWith({ name: "assistant", runtime: "grok", autoApprove: true }, {});
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("shows the host's reason inline and stays open when creation fails", async () => {
    const oncreatebot = vi.fn(async () => ({ ok: false as const, reason: "Claude Code is not signed in." }));
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    click('[data-testid="chat-create-new-bot"]');
    await settle();
    // ⌘↵ creates from the first step once the draft is complete.
    q('[data-testid="chat-create-bot-step"]')!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
    );
    await settle(10);
    expect(oncreatebot).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-create-entry-error"]')?.textContent).toContain("not signed in");
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-bot-step"]')).toBeTruthy();
  });

  it("blocks a bad or taken name, gates on a signed-in runtime, and never caps the bot count", async () => {
    const oncreatebot = vi.fn(async () => ({ ok: true as const, agentUid: "agt_new", name: "x" }));
    // No per-person limit: the row stays enabled no matter how many bots exist.
    mountSidebar({ companies: [INDIGO], oncreatebot });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-bot"]')!;
    expect(row.disabled).toBe(false);
    expect(row.textContent).not.toContain("Limit");
    await unmount(component!);
    component = null;
    mountSidebar({
      companies: [INDIGO],
      oncreatebot,
      botRuntimeReady: { claude: false, codex: true, grok: true },
      existingBotNames: ["scout"],
    });
    await settle();
    await openModal();
    await toHomeStep();
    // Claude is not signed in → the first signed-in runtime (Codex) is preselected.
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-runtime-codex"]')?.getAttribute("aria-checked")).toBe("true");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-runtime-claude"]')!.textContent).toContain("not signed in");
    click('[data-testid="chat-bot-runtime-claude"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("Claude Code is not signed in");
    click('[data-testid="chat-bot-runtime-codex"]');
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(false);
    click('[data-testid="create-bot-next"]');
    await settle();
    const name = q<HTMLInputElement>('[data-testid="chat-bot-name"]')!;
    name.value = "Bad Name";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain("Lowercase letters");
    name.value = "scout";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q('[data-testid="chat-bot-name-help"]')?.textContent).toContain("already have a bot named scout");
    // A suggestion chip fills a free name.
    const chip = q<HTMLButtonElement>('[data-testid="chat-bot-name-suggestion"]')!;
    expect(chip.textContent?.trim()).toBe("assistant");
    chip.click();
    await settle();
    expect(name.value).toBe("assistant");
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    expect(oncreatebot).not.toHaveBeenCalled();
  });
});

describe("ChatSidebar offers the user's local bots in the '+' modal", () => {
  it("finds a local bot by name even though the contacts roster omits it", async () => {
    mountSidebar({
      companies: [INDIGO],
      localBots: [{ name: "scout", agentUid: "agt_01SCOUT", ownerUid: "prs_me", runtime: "claude", state: "running", pid: 1, processAlive: true, online: true, lastHeartbeatAt: null, daemonInstalled: true, daemonLoaded: true, dir: "/tmp/scout" }],
    });
    await settle();
    await openModal();
    const query = q<HTMLInputElement>('[data-testid="chat-create-query"]')!;
    query.value = "scout";
    query.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(30);
    await vi.waitFor(() => expect(q('[data-testid="chat-create-modal"]')?.textContent).toContain("scout"));
  });
});
