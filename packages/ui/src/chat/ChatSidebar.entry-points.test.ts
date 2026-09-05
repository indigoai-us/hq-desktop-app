// @vitest-environment happy-dom

/**
 * Lifecycle entry points offered by the sidebar: "New company" / "New agent"
 * rows in the "+" modal and a "New company" row in the company switcher. The
 * sidebar never runs the server action itself — it calls the host callbacks
 * and either closes (success) or shows the reason inline (blocked).
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
    expect(q('[data-testid="chat-create-new-agent"]')).toBeNull();
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

  it("New agent with one company goes straight to it", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO], oncreateagent });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-agent"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Indigo");
    expect(row?.getAttribute("aria-haspopup")).toBeNull();
    row!.click();
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
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-agent"]');
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Ramen Bae");
    row!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_ramen_bae");
  });

  it("New agent with several companies shows an inline picker, keyboard included", async () => {
    const oncreateagent = vi.fn(async () => okTarget);
    mountSidebar({ companies: [INDIGO, ACME], oncreateagent });
    await settle();
    await openModal();
    const row = q<HTMLButtonElement>('[data-testid="chat-create-new-agent"]');
    expect(row?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(row?.getAttribute("aria-expanded")).toBe("false");
    expect(q('[data-testid="chat-create-agent-picker"]')).toBeNull();
    row!.click();
    await settle();
    expect(oncreateagent).not.toHaveBeenCalled();
    expect(row?.getAttribute("aria-expanded")).toBe("true");
    const picker = q('[data-testid="chat-create-agent-picker"]');
    expect(picker?.getAttribute("role")).toBe("listbox");
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '[data-testid="chat-create-agent-company"]',
      ),
    );
    expect(options.map((o) => o.dataset.company)).toEqual(["cmp_indigo", "cmp_acme"]);
    expect(options.map((o) => o.textContent?.trim())).toEqual(["I Indigo", "A Acme"]);

    // Arrow keys move between the company rows.
    options[0]!.focus();
    picker!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(options[1]);

    options[1]!.click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme");
    expect(q('[data-testid="chat-create-modal"]')).toBeNull();
  });

  it("shows a blocked reason inline where the picker was and keeps the modal open", async () => {
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
    q<HTMLButtonElement>('[data-testid="chat-create-new-agent"]')!.click();
    await settle();
    document
      .querySelector<HTMLButtonElement>('[data-company="cmp_acme"]')!
      .click();
    await settle(10);
    expect(oncreateagent).toHaveBeenCalledWith("cmp_acme");
    expect(q('[data-testid="chat-create-modal"]')).toBeTruthy();
    const error = q('[data-testid="chat-create-entry-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("Only owners can add agents.");
    // The error sits inside the entry-point group, under the picker.
    expect(
      q('[data-testid="chat-create-entry-points"]')?.contains(error!),
    ).toBe(true);
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
