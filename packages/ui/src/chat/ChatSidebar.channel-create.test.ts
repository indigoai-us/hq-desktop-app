// @vitest-environment happy-dom

/**
 * New-channel "In" scope, driven through the unified create modal (the
 * sidebar "+" → search-first CreateModal). Originally written against the old
 * "New channel" modal (#597); every test keeps its intent — default In is the
 * active company, the personal vault is never a company scope, membership
 * blocks submit inline, and a failed create only re-enables retry when nothing
 * by that name landed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api.js";
import type { Workspace } from "./workspaces.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

function workspace(partial: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_acme",
    bucketName: null,
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...partial,
  };
}

const COMPANIES: Workspace[] = [
  workspace({
    slug: "corey-epstein",
    displayName: "Corey Epstein",
    cloudUid: "cmp_personal",
    role: "owner",
  }),
  workspace({
    slug: "indigo",
    displayName: "Indigo",
    cloudUid: "cmp_indigo",
    role: "owner",
  }),
  workspace({
    slug: "liverecover",
    displayName: "LiveRecover",
    cloudUid: "cmp_lr",
    role: "member",
  }),
];

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_channel_create_000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [
        {
          channelId: "chn_launch",
          name: "launch",
          scope: "company",
          companyUid: "cmp_indigo",
          lastActivityAt: now(),
        },
      ],
    }),
    listContacts: async () => ({
      contacts: [
        {
          personUid: "prs_stefan",
          displayName: "Stefan Johnson",
          companyUid: "cmp_indigo",
          lastActivityAt: now(),
        },
        {
          personUid: "prs_yousuf",
          displayName: "Yousuf Kalim",
          companyUid: "cmp_indigo",
          lastActivityAt: now(),
        },
        {
          personUid: "prs_shawon",
          displayName: "Shawon Majid",
          companyUid: "cmp_indigo",
          lastActivityAt: now(),
        },
        {
          personUid: "prs_caitlin",
          displayName: "Caitlin",
          companyUid: "cmp_lr",
          lastActivityAt: now(),
        },
      ],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    createChannel: async () => ({ channelId: "chn_new" }),
    addChannelMember: async () => {},
    ...overrides,
  };
}

async function mountSidebar(
  props: Record<string, unknown> = {},
): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      companies: COMPANIES,
      accountLabel: "Corey Epstein",
      self: { uid: "prs_corey", displayName: "Corey Epstein" },
      ...props,
    },
  });
  await tick();
  await tick();
}

/** Clear the modal's 110 ms query debounce. */
async function settleQuery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await tick();
}

/**
 * "+" → type the new channel's name → "Create channel #…" row. The unified
 * modal has no separate "New channel" entry: the name IS the way in.
 */
async function openNewChannelModal(name = "HQ Desktop Bugs"): Promise<void> {
  (
    host.querySelector(
      '[data-testid="chat-new-message"]',
    ) as HTMLButtonElement | null
  )?.click();
  await tick();
  const query = document.querySelector(
    '[data-testid="chat-create-query"]',
  ) as HTMLInputElement;
  expect(query).toBeTruthy();
  query.value = name;
  query.dispatchEvent(new Event("input", { bubbles: true }));
  await settleQuery();
  const createRow = document.querySelector(
    '[data-testid="chat-create-channel-row"]',
  ) as HTMLButtonElement | null;
  expect(createRow).toBeTruthy();
  createRow?.click();
  await tick();
  expect(
    (document.querySelector('[data-testid="chat-channel-name"]') as HTMLInputElement)
      .value,
  ).toBe(name);
}

async function addParticipant(query: string): Promise<void> {
  const input = document.querySelector(
    '[data-testid="chat-channel-participants"]',
  ) as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
  const suggestion = document.querySelector(
    '[data-testid="chat-channel-suggestion"]',
  ) as HTMLButtonElement | null;
  expect(suggestion?.textContent).toContain(query);
  suggestion?.click();
  await tick();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document
    .querySelectorAll('[data-testid="chat-create-modal"]')
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
});

describe("ChatSidebar new-channel scope", () => {
  it("defaults In to the active company, not the personal membership", async () => {
    await mountSidebar({ scopeUid: "cmp_indigo" });
    await openNewChannelModal();

    const select = document.querySelector(
      '[data-testid="chat-channel-scope"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("cmp_indigo");
    expect([...select.options].map((option) => option.value)).toEqual([
      "cmp_indigo",
      "cmp_lr",
      "",
    ]);
    expect(select.textContent).not.toContain("Corey Epstein");
  });

  it("restricts In to companies every selected member belongs to", async () => {
    await mountSidebar({ scopeUid: "all" });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="dm:prs_stefan"]'),
      ).toBeTruthy();
    });
    await openNewChannelModal();
    await addParticipant("Stefan Johnson");
    await addParticipant("Yousuf Kalim");

    const select = document.querySelector(
      '[data-testid="chat-channel-scope"]',
    ) as HTMLSelectElement;
    expect(select.value).toBe("cmp_indigo");
    expect(
      [...select.options].find((option) => option.value === "")?.disabled ??
        true,
    ).toBe(true);
    expect(
      [...select.options].find((option) => option.value === "cmp_lr")?.disabled,
    ).toBe(true);
    expect(
      document.querySelector('[data-testid="chat-channel-scope-unavailable"]')
        ?.textContent,
    ).toContain("isn't a member of LiveRecover");
  });

  it("blocks submit with an inline membership message instead of calling create", async () => {
    const createChannel = vi.fn(async () => ({ channelId: "chn_new" }));
    await mountSidebar({
      scopeUid: "all",
      api: stubApi({ createChannel }),
    });
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-conversation-id="dm:prs_stefan"]'),
      ).toBeTruthy();
    });
    await openNewChannelModal("HQ Desktop Bugs");
    await addParticipant("Stefan Johnson");
    await addParticipant("Caitlin");

    const create = document.querySelector(
      '[data-testid="chat-channel-create"]',
    ) as HTMLButtonElement;
    expect(
      document.querySelector('[data-testid="chat-channel-validation"]')
        ?.textContent,
    ).toMatch(/isn't a member of Personal/i);
    expect(create.disabled).toBe(true);
    create.click();
    await tick();
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("re-enables retry after a server error when no channel with that name exists", async () => {
    const createChannel = vi.fn(async () => {
      throw new Error(
        "[invoke] You are not an active member of this company.",
      );
    });
    await mountSidebar({
      scopeUid: "cmp_indigo",
      api: stubApi({
        createChannel,
        listChannels: async () => ({ channels: [] }),
      }),
    });
    await openNewChannelModal("HQ Desktop Bugs");

    const create = document.querySelector(
      '[data-testid="chat-channel-create"]',
    ) as HTMLButtonElement;
    create.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="chat-channel-error"]')
          ?.textContent,
      ).toContain("you can try again");
    });
    expect(createChannel).toHaveBeenCalledTimes(1);
    expect(create.disabled).toBe(false);
    expect(create.textContent).not.toContain("Creation unconfirmed");
  });

  it("keeps retry disabled when a channel with that name now exists", async () => {
    // The create "fails" but commits server-side: the channel is absent before
    // the call and listed right after it. (Listing it up front would make the
    // modal's own collision check hoist the existing channel instead.)
    let landed = false;
    const createChannel = vi.fn(async () => {
      landed = true;
      throw new Error(
        "[invoke] You are not an active member of this company.",
      );
    });
    await mountSidebar({
      scopeUid: "cmp_indigo",
      api: stubApi({
        createChannel,
        listChannels: async () => ({
          channels: landed
            ? [
                {
                  channelId: "chn_bugs",
                  name: "HQ Desktop Bugs",
                  scope: "company",
                  companyUid: "cmp_indigo",
                },
              ]
            : [],
        }),
      }),
    });
    await openNewChannelModal("HQ Desktop Bugs");

    const create = document.querySelector(
      '[data-testid="chat-channel-create"]',
    ) as HTMLButtonElement;
    create.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="chat-channel-error"]')
          ?.textContent,
      ).toContain("retry is disabled");
    });
    expect(create.disabled).toBe(true);
    expect(create.textContent).toContain("Creation unconfirmed");
    create.click();
    await tick();
    expect(createChannel).toHaveBeenCalledTimes(1);
  });
});
