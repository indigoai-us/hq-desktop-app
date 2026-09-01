// @vitest-environment happy-dom

/**
 * Sidebar-level tests for the unified create flow.
 *
 * Replaces ChatSidebar.compose.test.ts: the "+" dropdown and both old modals
 * are gone, so the two guarantees that file carried (picking a suggestion opens
 * the conversation; an unknown name creates the channel and sends the drafted
 * body as its first message) are re-asserted here against the new one-modal
 * shell.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import { createFixtureChatSidebarApi } from "../shell/fixtures.js";
import { createChatWakeBus } from "./chat-api.js";
import type { Workspace } from "./workspaces.js";
import type { ConversationRow } from "./sidebar-model.js";

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
  role: "member",
  lastSyncedAt: null,
  brokenReason: null,
  invitedBy: null,
  invitedAt: null,
};

const seedDirectory = [
  {
    channelId: "hq-desktop",
    name: "hq-desktop",
    scope: "company",
    lastActivityAt: new Date().toISOString(),
  },
];

/** Clear the modal's 110 ms query debounce. */
async function settleQuery(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
  await tick();
}

function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.value = value;
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(node: EventTarget, key: string) {
  node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function openModal(): void {
  host
    .querySelector<HTMLButtonElement>('[data-testid="chat-new-message"]')
    ?.click();
}

function queryInput(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>(
    '[data-testid="chat-create-query"]',
  );
  expect(node).toBeTruthy();
  return node as HTMLInputElement;
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
    .querySelectorAll('[data-testid="chat-create-modal"]')
    .forEach((node) => node.remove());
  window.localStorage?.clear?.();
});

describe("ChatSidebar create flow", () => {
  it("the + button opens the create modal directly", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: { api: createFixtureChatSidebarApi(), seedDirectory },
    });
    await tick();
    await tick();

    const plus = host.querySelector<HTMLButtonElement>(
      '[data-testid="chat-new-message"]',
    );
    expect(plus).toBeTruthy();
    expect(plus?.getAttribute("aria-haspopup")).toBe("dialog");
    plus?.click();
    await tick();

    expect(
      document.querySelector('[data-testid="chat-create-modal"]'),
    ).toBeTruthy();
    // The old dropdown is gone for good (it also rendered clipped).
    expect(
      document.querySelector('[data-testid="chat-plus-new-message"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="chat-plus-new-channel"]'),
    ).toBeNull();
  });

  it("picking a suggestion opens that conversation", async () => {
    const onselect = vi.fn<(row: ConversationRow) => void>();
    component = mount(ChatSidebar, {
      target: host,
      props: { api: createFixtureChatSidebarApi(), seedDirectory, onselect },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "Bryan");
    await settleQuery();

    const suggestion = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-create-result"]',
    );
    expect(suggestion?.textContent).toContain("Bryan");
    suggestion?.click();
    await tick();

    expect(onselect).toHaveBeenCalled();
    // Null also catches a portal leak from the orphan-node sweep.
    expect(
      document.querySelector('[data-testid="chat-create-modal"]'),
    ).toBeNull();
  });

  it("an unknown name offers a lowercase slug and carries it into the create step", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...createFixtureChatSidebarApi(),
          createChannel: vi.fn(async () => ({ channelId: "chn_new" })),
        },
        companies: [INDIGO],
        seedDirectory,
      },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "Q4 board");
    await settleQuery();

    const createRow = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-create-channel-row"]',
    );
    expect(createRow?.textContent).toContain("#q4-board");
    expect(createRow?.textContent).not.toContain("Q4-board");
    createRow?.click();
    await tick();

    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="chat-channel-name"]',
      )?.value,
    ).toBe("Q4 board");
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="chat-channel-slug"]',
      )?.value,
    ).toBe("q4-board");
  });

  it("creates, adds the member, sends the first message, and shows the channel immediately", async () => {
    const createChannel = vi.fn(async () => ({ channelId: "chn_new" }));
    const addChannelMember = vi.fn(async () => {});
    const sendChannelMessage = vi.fn(async () => {});
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...createFixtureChatSidebarApi(),
          createChannel,
          addChannelMember,
          sendChannelMessage,
        },
        companies: [INDIGO],
        seedDirectory,
      },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "Q4 board");
    await settleQuery();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="chat-create-channel-row"]',
      )
      ?.click();
    await tick();

    // Add one member from the full directory roster.
    const picker = document.querySelector<HTMLInputElement>(
      '[data-testid="chat-channel-participants"]',
    );
    expect(picker).toBeTruthy();
    type(picker as HTMLInputElement, "Bryan");
    await tick();
    const suggestion = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-channel-suggestion"]',
    );
    expect(suggestion?.textContent).toContain("Bryan");
    suggestion?.click();
    await tick();
    expect(
      document.querySelectorAll('[data-testid="chat-channel-chip"]'),
    ).toHaveLength(1);

    type(
      document.querySelector<HTMLTextAreaElement>(
        '[data-testid="chat-channel-first-message"]',
      ) as HTMLTextAreaElement,
      "kicking this off",
    );
    await tick();

    document
      .querySelector<HTMLButtonElement>('[data-testid="chat-channel-create"]')
      ?.click();
    await vi.waitFor(() => {
      expect(sendChannelMessage).toHaveBeenCalled();
    });
    await tick();

    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Q4 board", scope: "company" }),
    );
    expect(addChannelMember).toHaveBeenCalledWith("chn_new", "person-bryan");
    expect(sendChannelMessage).toHaveBeenCalledWith({
      channelId: "chn_new",
      body: "kicking this off",
    });
    // The new channel is in the rail immediately (optimistic upsert).
    expect(host.textContent).toContain("Q4 board");
  });

  // Regression: `activeIndex` was only reset when the query changed, so a live
  // roster update could shrink the list under it. `aria-activedescendant` then
  // pointed at a node that no longer existed and Enter activated something the
  // user could not see was highlighted.
  it("keeps the highlight valid when the roster shrinks under it", async () => {
    const wakes = createChatWakeBus();
    let shrunk = false;
    const contacts = [
      { personUid: "prs_a1", displayName: "Alpha One" },
      { personUid: "prs_a2", displayName: "Alpha Two" },
      { personUid: "prs_a3", displayName: "Alpha Three" },
    ];
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...createFixtureChatSidebarApi(),
          listContacts: async () => ({
            contacts: shrunk ? contacts.slice(0, 1) : contacts,
          }),
        },
        wakes,
        companies: [INDIGO],
        seedDirectory,
      },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "Alpha");
    await settleQuery();
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll('[data-testid="chat-create-result"]').length,
      ).toBe(3);
    });

    const input = queryInput();
    press(input, "ArrowDown");
    press(input, "ArrowDown");
    await tick();
    expect(input.getAttribute("aria-activedescendant")).toBe("create-opt-2");

    // A wake-driven refresh drops two of the three matches.
    shrunk = true;
    wakes.emit("dm:request-update", { pairKey: "pair-1" });
    await vi.waitFor(
      () => {
        expect(
          document.querySelectorAll('[data-testid="chat-create-result"]')
            .length,
        ).toBe(1);
      },
      { timeout: 3000 },
    );
    await tick();

    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    // The highlight names a live node, and exactly one option claims it.
    expect(document.getElementById(active as string)).toBeTruthy();
    const selected = document.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(active);
  });

  it("a host without createChannel still opens the modal but offers no create row", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: { api: createFixtureChatSidebarApi(), seedDirectory },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "hq");
    await settleQuery();

    expect(
      document.querySelector('[data-testid="chat-create-channel-row"]'),
    ).toBeNull();
    expect(
      document.querySelectorAll('[data-testid="chat-create-result"]').length,
    ).toBeGreaterThan(0);
  });

  // Carried over from the retired compose modal (upstream e72454eb): the
  // synthetic #setup support row is pinned first in the rail, so with an
  // empty query it used to be the FIRST suggestion and a fast type-then-Enter
  // misrouted the draft to channelId "setup".
  it("excludes the synthetic #setup channel from create results", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: createFixtureChatSidebarApi(),
        seedDirectory: [
          {
            channelId: "chn_existing",
            name: "existing",
            scope: "company",
            lastActivityAt: new Date().toISOString(),
          },
        ],
      },
    });
    await tick();
    await tick();
    // The rail itself still pins #setup — only the create flow hides it.
    expect(host.textContent).toMatch(/setup/i);

    openModal();
    await tick();
    const results = Array.from(
      document.querySelectorAll('[data-testid="chat-create-result"]'),
    );
    expect(results.length).toBeGreaterThan(0);
    for (const node of results) {
      expect(node.textContent).not.toMatch(/#?\bsetup\b/i);
    }

    type(queryInput(), "setup");
    await settleQuery();
    expect(
      document.querySelector('[data-testid="chat-create-result"]'),
    ).toBeNull();
  });

  // Carried over from the retired compose modal (upstream f01cf7dc): rows that
  // read identically need a muted disambiguator — the email for people.
  it("renders a secondary disambiguator on result rows", async () => {
    component = mount(ChatSidebar, {
      target: host,
      props: { api: createFixtureChatSidebarApi(), seedDirectory },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "bryan");
    await settleQuery();

    await vi.waitFor(() => {
      const results = Array.from(
        document.querySelectorAll('[data-testid="chat-create-result"]'),
      );
      expect(results.length).toBeGreaterThan(0);
      const withEmail = results.find((node) =>
        (
          node.querySelector('[data-testid="chat-create-result-meta"]')
            ?.textContent ?? ""
        ).includes("@"),
      );
      expect(withEmail?.textContent).toContain("Bryan");
      expect(
        withEmail
          ?.querySelector('[data-testid="chat-create-result-meta"]')
          ?.textContent?.trim(),
      ).toBe("bryan@getindigo.ai");
    });
  });

  // Carried over from the retired compose modal (upstream f01cf7dc): duplicate
  // 1:1 group channels for the same counterpart originate server-side. The
  // sidebar collapses identical rosters before they reach the create modal.
  it("collapses duplicate group rosters to one result row", async () => {
    const jacob = [{ personUid: "prs_jacob", displayName: "Jacob Posel" }];
    const groups = ["chn_g1", "chn_g2", "chn_g3"].map((channelId, index) => ({
      channelId,
      name: "",
      scope: "group",
      members: jacob,
      memberCount: 1,
      lastActivityAt: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    // The directory snapshot replaces the seed, so the duplicates have to
    // arrive the way they do in production: from the server feed.
    const base = createFixtureChatSidebarApi();
    const api = {
      ...base,
      fetchChannelDirectory: async (cursor: string | null) => {
        const feed = await base.fetchChannelDirectory(cursor);
        return { ...feed, rows: [...(feed.rows ?? []), ...groups] };
      },
    };
    component = mount(ChatSidebar, {
      target: host,
      props: { api, seedDirectory },
    });
    await tick();
    await tick();
    openModal();
    await tick();

    type(queryInput(), "jacob posel");
    await settleQuery();

    const results = Array.from(
      document.querySelectorAll('[data-testid="chat-create-result"]'),
    ).filter((node) => (node.textContent ?? "").includes("Jacob Posel"));
    expect(results).toHaveLength(1);
  });
});
