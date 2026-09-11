// @vitest-environment happy-dom

/**
 * Lifecycle entry points offered by the sidebar: "New company" / "New agent"
 * rows in the "+" MENU (they used to live inside the create modal, which is
 * now a message composer — creating a company is not a message) and a "New
 * company" row in the company switcher. The sidebar never runs the server
 * action itself — it calls the host callbacks and either closes (success) or
 * shows the reason inline (blocked).
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

function mountSidebar(props: Record<string, unknown>): void {
  component = mount(ChatSidebar, {
    target: host,
    props: { api: createFixtureChatSidebarApi(), seedDirectory, ...props },
  });
}

/** Open the "+" menu, where the entry points live. */
async function openMenu(): Promise<void> {
  host.querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')!.click();
  await settle();
}

/** Open the "+" menu and go through to the composer behind "New message". */
async function openModal(): Promise<void> {
  await openMenu();
  document
    .querySelector<HTMLButtonElement>('[data-testid="chat-new-message-item"]')!
    .click();
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
    await openMenu();
    expect(q('[data-testid="chat-new-message-item"]')).toBeTruthy();
    expect(q('[data-testid="chat-new-company-item"]')).toBeNull();
    expect(q('[data-testid="chat-new-agent-item"]')).toBeNull();
  });

  it("the composer offers no entry points — it only sends messages", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatecompany, oncreateagent });
    await settle();
    await openModal();
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    expect(q('[data-testid="chat-create-entry-points"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-company"]')).toBeNull();
    expect(q('[data-testid="chat-create-new-agent"]')).toBeNull();
    expect(q('[data-testid="chat-compose-body"]')).toBeTruthy();
  });

  it("New company calls the host and closes the menu on success", async () => {
    const oncreatecompany = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreatecompany });
    await settle();
    await openMenu();
    const row = q<HTMLButtonElement>('[data-testid="chat-new-company-item"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("New company");
    row!.click();
    await settle(10);
    expect(oncreatecompany).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="chat-new-company-item"]')).toBeNull();
  });

  it("New agent with one company goes straight to it", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openMenu();
    const row = q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]');
    expect(row).toBeTruthy();
    row!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo");
    expect(q('[data-testid="chat-new-agent-item"]')).toBeNull();
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
    await openMenu();
    const row = q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]');
    expect(row).toBeTruthy();
    row!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_ramen_bae");
  });

  // An agent belongs to one company and costs real money, so with more than
  // one to choose from the menu asks instead of guessing. It used to target
  // "the active scope, else the first company", which billed the wrong one on
  // a mis-click and only surfaced later, on an invoice.
  it("New agent asks which company when there is more than one", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent });
    await settle();
    await openMenu();
    q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]')!.click();
    await settle(10);

    expect(oncreateagent).not.toHaveBeenCalled();
    const rows = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-new-agent-company"]',
      ),
    ];
    expect(rows.map((r) => r.dataset.companyUid)).toEqual([
      "cmp_indigo",
      "cmp_acme",
    ]);

    rows[1].click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme");
  });

  it("New agent skips the question when there is only one company", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openMenu();
    q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]')!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo");
    expect(q('[data-testid="chat-new-agent-company"]')).toBeFalsy();
  });

  it("Back returns to the menu the picker replaced", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent });
    await settle();
    await openMenu();
    q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]')!.click();
    await settle(10);
    q<HTMLButtonElement>('[data-testid="chat-new-agent-back"]')!.click();
    await settle();

    expect(q('[data-testid="chat-new-agent-company"]')).toBeFalsy();
    expect(q('[data-testid="chat-new-agent-item"]')).toBeTruthy();
    expect(oncreateagent).not.toHaveBeenCalled();
  });

  it("shows a blocked reason inline in the menu and keeps it open", async () => {
    const oncreateagent = vi.fn(
      async (): Promise<EntryPointResult> => ({
        ok: false,
        reason: "Only owners can add agents.",
        blocked: true,
      }),
    );
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openMenu();
    q<HTMLButtonElement>('[data-testid="chat-new-agent-item"]')!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_indigo");
    expect(q('[data-testid="chat-new-agent-item"]')).toBeTruthy();
    const error = q('[data-testid="chat-new-error"]');
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
