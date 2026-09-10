// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { writeSettingsPrefs } from "../settings/settings-prefs.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "ChatSidebar.svelte"),
  "utf8",
);

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const now = () => new Date().toISOString();

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

const LIVERECOVER: Workspace = {
  ...INDIGO,
  slug: "liverecover",
  displayName: "Liverecover",
  cloudUid: "cmp_lr",
};

const seedDirectory: ChannelDirectoryRow[] = [
  {
    channelId: "hq-desktop",
    type: "project",
    scope: "project",
    companyUid: "cmp_indigo",
    name: "hq-desktop",
    lastActivityAt: now(),
  },
  {
    channelId: "long-name",
    type: "project",
    scope: "project",
    companyUid: "cmp_lr",
    name: "a-very-long-channel-name-that-should-truncate-in-the-narrow-rail",
    lastActivityAt: now(),
  },
  {
    channelId: "unread-desk",
    type: "project",
    scope: "project",
    companyUid: "cmp_indigo",
    name: "unread-desk",
    lastActivityAt: now(),
    unreadCount: 3,
  },
];

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_rail_labels_0000000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedDirectory,
    }),
    listContacts: async () => ({
      contacts: [
        {
          personUid: "agt_fleet",
          displayName: "Fleet",
          companyUid: "cmp_indigo",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
        {
          personUid: "prs_ada",
          displayName: "Ada Lovelace",
          email: "ada@getindigo.ai",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
        {
          personUid: "prs_alex_a",
          displayName: "Alex",
          email: "alex@indigo.ai",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
        {
          personUid: "prs_alex_b",
          displayName: "Alex",
          email: "alex@liverecover.com",
          lastActivityAt: now(),
          lastDmAt: now(),
        },
      ],
    }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
    ...overrides,
  };
}

function mountSidebar(
  extras: Record<string, unknown> = {},
): ReturnType<typeof mount> {
  return mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory,
      companies: [INDIGO, LIVERECOVER],
      self: { uid: "prs_stefan", displayName: "Stefan" },
      selectedId: "ch:hq-desktop",
      ...extras,
    },
  });
}

function row(id: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(
    `[data-conversation-id="${id}"]`,
  );
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

function scopeOf(id: string): HTMLElement | null {
  return host.querySelector(
    `[data-conversation-id="${id}"] [data-testid="chat-row-scope"]`,
  );
}

function liOf(id: string): HTMLElement | null {
  return (
    host
      .querySelector(`[data-conversation-id="${id}"]`)
      ?.closest<HTMLElement>(".chat-li") ?? null
  );
}

beforeEach(() => {
  memoryStorage.clear();
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

describe("ChatSidebar company / email labels", () => {
  it("channel rows in All scope show the company label", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("ch:hq-desktop")?.textContent).toBe("Indigo");
    });
    expect(scopeOf("ch:hq-desktop")?.getAttribute("data-kind")).toBe("company");
  });

  it("agent DMs in All scope show the company name", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("dm:agt_fleet")?.textContent).toBe("Indigo");
    });
    expect(scopeOf("dm:agt_fleet")?.getAttribute("data-kind")).toBe("company");
  });

  it("human DMs in All scope show email", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("dm:prs_ada")?.textContent).toBe("ada@getindigo.ai");
    });
    expect(scopeOf("dm:prs_ada")?.getAttribute("data-kind")).toBe("email");
  });

  it("single-company scope hides company labels", async () => {
    component = mountSidebar({ scopeUid: "cmp_indigo" });
    await vi.waitFor(() => {
      expect(row("ch:hq-desktop")).toBeTruthy();
      expect(row("dm:agt_fleet")).toBeTruthy();
    });
    expect(scopeOf("ch:hq-desktop")).toBeNull();
    expect(scopeOf("dm:agt_fleet")).toBeNull();
  });

  it("duplicate-name humans keep email in single-company scope", async () => {
    component = mountSidebar({ scopeUid: "cmp_indigo" });
    await vi.waitFor(() => {
      expect(scopeOf("dm:prs_alex_a")?.textContent).toBe("alex@indigo.ai");
      expect(scopeOf("dm:prs_alex_b")?.textContent).toBe("alex@liverecover.com");
    });
    expect(scopeOf("dm:prs_ada")).toBeNull();
  });

  it("long names truncate with ellipsis styles and the label is hover-only", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(row("ch:long-name")).toBeTruthy();
      expect(scopeOf("ch:long-name")?.textContent).toBe("Liverecover");
    });

    const copy = row("ch:long-name").querySelector(".chat-row-copy");
    const title = row("ch:long-name").querySelector(".chat-row-title");
    const scope = scopeOf("ch:long-name");
    expect(copy).toBeTruthy();
    expect(title?.textContent).toContain(
      "a-very-long-channel-name-that-should-truncate-in-the-narrow-rail",
    );
    expect(scope?.className).toMatch(/chat-row-scope/);

    expect(src).toMatch(
      /\.chat-row-copy\s*\{[\s\S]*?overflow:\s*hidden;[\s\S]*?\}/,
    );
    expect(src).toMatch(
      /\.chat-row-copy \.chat-row-title\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/,
    );
    // Hidden at rest, revealed on hover / keyboard focus — and no second
    // overlay copy of the same text.
    expect(src).toMatch(
      /\.chat-row-scope\s*\{[\s\S]*?display:\s*none;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;[\s\S]*?font-size:\s*12px;[\s\S]*?font-weight:\s*400;/,
    );
    expect(src).toMatch(
      /\.chat-li:hover \.chat-row-scope,\s*\n\s*\.chat-li:focus-within \.chat-row-scope\s*\{\s*display:\s*inline;/,
    );
    expect(src).not.toMatch(/chat-row-reveal/);
  });

  it("keeps unread badges and puts the pin control to their left", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(row("ch:unread-desk")).toBeTruthy();
    });
    const unread = row("ch:unread-desk");
    expect(unread.classList.contains("has-badge")).toBe(true);
    const li = liOf("ch:unread-desk");
    expect(li).toBeTruthy();
    expect(
      li?.querySelector('[data-testid="chat-unread-badge"]')?.textContent,
    ).toBe("3");

    // Row button, then pin, then badge — the pin lives inside the hover fill
    // and never to the right of an indicator.
    const order = [...(li?.children ?? [])].map((child) =>
      child.getAttribute("data-testid") ?? child.className.split(" ")[0],
    );
    expect(order).toEqual(["chat-row", "chat-pin", "chat-unread-badge"]);

    // `.chat-li` — not `.chat-row` — carries the hover and selected fills, so
    // the trailing controls sit inside the highlighted box.
    expect(src).toMatch(/\.chat-li:hover\s*\{\s*background:\s*var\(--hover\);/);
    expect(src).toMatch(/\.chat-li\.active\s*\{\s*background:\s*var\(--sel\);/);
    // Pin shows on hover or focus only — never as a resting badge.
    expect(src).toMatch(
      /\.chat-li:hover \.chat-pin-btn,\s*\n\s*\.chat-pin-btn:focus-visible\s*\{\s*opacity:\s*1;/,
    );
  });

  it("toggle off hides all company and email labels", async () => {
    writeSettingsPrefs({ showSidebarScopeLabels: false }, memoryStorage);
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(row("ch:hq-desktop")).toBeTruthy();
      expect(row("dm:agt_fleet")).toBeTruthy();
      expect(row("dm:prs_ada")).toBeTruthy();
    });
    expect(host.querySelectorAll('[data-testid="chat-row-scope"]').length).toBe(
      0,
    );
  });
});
