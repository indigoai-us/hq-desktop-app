// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

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
];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_sublabel_tooltip_000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedDirectory,
    }),
    listContacts: async () => ({
      contacts: [
        {
          personUid: "prs_jacob",
          displayName: "Jacob Posel",
          email: "jacob@getindigo.ai",
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
  };
}

function mountSidebar(): ReturnType<typeof mount> {
  return mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory,
      companies: [INDIGO, LIVERECOVER],
      self: { uid: "prs_stefan", displayName: "Stefan" },
      selectedId: "ch:hq-desktop",
    },
  });
}

function rowOf(id: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(
    `[data-conversation-id="${id}"]`,
  );
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

function scopeOf(id: string): HTMLElement {
  const node = host.querySelector<HTMLElement>(
    `[data-conversation-id="${id}"] [data-testid="chat-row-scope"]`,
  );
  expect(node).toBeTruthy();
  return node as HTMLElement;
}

/** Pretend the label overflows its box, the way a narrow rail clips it. */
function measureAs(
  node: HTMLElement,
  { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number },
) {
  Object.defineProperty(node, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(node, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
  node.dispatchEvent(new Event("mouseenter"));
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

describe("sidebar sub-label tooltips", () => {
  it("a DM email sub-label that fits carries no tooltip", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("dm:prs_jacob").textContent).toBe("jacob@getindigo.ai");
    });
    const scope = scopeOf("dm:prs_jacob");
    measureAs(scope, { scrollWidth: 90, clientWidth: 90 });
    expect(scope.hasAttribute("title")).toBe(false);
    expect(rowOf("dm:prs_jacob").hasAttribute("title")).toBe(false);
  });

  it("a truncated DM email sub-label shows the full address as its tooltip", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("dm:prs_jacob").textContent).toBe("jacob@getindigo.ai");
    });
    const scope = scopeOf("dm:prs_jacob");
    measureAs(scope, { scrollWidth: 240, clientWidth: 90 });
    expect(scope.getAttribute("title")).toBe("jacob@getindigo.ai");
  });

  it("a channel row's company sub-label follows the same rule", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("ch:hq-desktop").textContent).toBe("Indigo");
    });
    const scope = scopeOf("ch:hq-desktop");
    measureAs(scope, { scrollWidth: 40, clientWidth: 40 });
    expect(scope.hasAttribute("title")).toBe(false);

    measureAs(scope, { scrollWidth: 160, clientWidth: 40 });
    expect(scope.getAttribute("title")).toBe("Indigo");
  });

  it("the row's accessible name still contains the sub-label text", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(scopeOf("dm:prs_jacob").textContent).toBe("jacob@getindigo.ai");
    });
    const row = rowOf("dm:prs_jacob");
    expect(row.hasAttribute("aria-label")).toBe(false);
    expect(row.textContent).toContain("Jacob Posel");
    expect(row.textContent).toContain("jacob@getindigo.ai");
  });
});
