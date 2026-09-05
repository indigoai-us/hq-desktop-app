// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { MARKETPLACE_COVER_HOST } from "../avatars/csp-image-src.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

const ICON = `https://${MARKETPLACE_COVER_HOST}/branding/cmp_indigo/favicon.png?X-Amz-Signature=mock`;

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

/** A second company that has NOT set a website — no icon anywhere. */
const NOICON: Workspace = {
  ...INDIGO,
  slug: "noicon",
  displayName: "No Icon Co",
  cloudUid: "cmp_noicon",
};

const seedDirectory: ChannelDirectoryRow[] = [
  // Company channel WITH a server-stamped icon.
  {
    channelId: "chn_company_indigo",
    type: "chat",
    scope: "company",
    companyUid: "cmp_indigo",
    name: "indigo",
    lastActivityAt: now(),
    iconUrl: ICON,
  },
  // Company channel whose company has NO icon.
  {
    channelId: "chn_company_noicon",
    type: "chat",
    scope: "company",
    companyUid: "cmp_noicon",
    name: "noicon",
    lastActivityAt: now(),
  },
  // Project channel in an iconful company — must KEEP the generic `#`.
  {
    channelId: "chn_project",
    type: "project",
    scope: "project",
    companyUid: "cmp_indigo",
    name: "hq-desktop",
    lastActivityAt: now(),
  },
  // Personal channel — must KEEP the generic `#`.
  {
    channelId: "chn_personal",
    type: "chat",
    scope: "personal",
    companyUid: null,
    name: "notes",
    lastActivityAt: now(),
  },
];

function stubApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_company_icon_00000000000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: seedDirectory,
    }),
    listContacts: async () => ({ contacts: [] }),
    listDmRequests: async () => ({ requests: [] }),
    listChannels: async () => null,
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    sendChannelMessage: async () => {},
    sendDm: async () => {},
    searchMessages: async () => ({ results: [] }),
  };
}

function mountSidebar(extras: Record<string, unknown> = {}) {
  return mount(ChatSidebar, {
    target: host,
    props: {
      api: stubApi(),
      seedDirectory,
      companies: [{ ...INDIGO, iconUrl: ICON }, NOICON],
      self: { uid: "prs_stefan", displayName: "Stefan" },
      selectedId: "ch:chn_company_indigo",
      ...extras,
    },
  });
}

function mark(channelId: string): HTMLElement | null {
  return host.querySelector(
    `[data-conversation-id="ch:${channelId}"] [data-testid="company-icon"]`,
  );
}

function hash(channelId: string): HTMLElement | null {
  return host.querySelector(
    `[data-conversation-id="ch:${channelId}"] .chat-glyph`,
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

describe("ChatSidebar rail — company channel marks", () => {
  it("renders the company favicon on a company channel row", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(mark("chn_company_indigo")).toBeTruthy();
    });
    expect(mark("chn_company_indigo")?.getAttribute("data-company-icon")).toBe(
      "image",
    );
    expect(
      host.querySelector(
        `[data-conversation-id="ch:chn_company_indigo"] img.company-icon-img`,
      )?.getAttribute("src"),
    ).toBe(ICON);
    // The generic hash is gone for this row.
    expect(hash("chn_company_indigo")).toBeNull();
  });

  it("renders the building glyph for a company with no icon", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(mark("chn_company_noicon")).toBeTruthy();
    });
    expect(mark("chn_company_noicon")?.getAttribute("data-company-icon")).toBe(
      "glyph",
    );
    expect(hash("chn_company_noicon")).toBeNull();
  });

  it("KEEPS the generic # on project and personal channels", async () => {
    component = mountSidebar();
    await vi.waitFor(() => {
      expect(hash("chn_project")).toBeTruthy();
    });
    // Only company-scoped rows change; the design system does not otherwise
    // differentiate project/personal channels.
    expect(hash("chn_project")?.textContent).toBe("#");
    expect(mark("chn_project")).toBeNull();
    expect(hash("chn_personal")?.textContent).toBe("#");
    expect(mark("chn_personal")).toBeNull();
  });

  it("falls back to the company roster when the ROW carries no icon", async () => {
    // A v-old server sends no per-row iconUrl at all; the membership roster
    // still knows the icon, so the rail must still paint it.
    const rowsWithoutIcons = seedDirectory.map(({ iconUrl: _drop, ...r }) => r);
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...stubApi(),
          fetchChannelDirectory: async () => ({
            snapshot: true,
            cursor: "cur_company_icon_00000000000000000001",
            cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            rows: rowsWithoutIcons,
          }),
        },
        seedDirectory: rowsWithoutIcons,
        companies: [{ ...INDIGO, iconUrl: ICON }, NOICON],
        self: { uid: "prs_stefan", displayName: "Stefan" },
        selectedId: "ch:chn_company_indigo",
      },
    });
    await vi.waitFor(() => {
      expect(mark("chn_company_indigo")?.getAttribute("data-company-icon")).toBe(
        "image",
      );
    });
  });

  it("renders every row against a v-old server that serves NO icons at all", async () => {
    // Neither the rows nor the roster carry icons — the rail must still render
    // completely, with building glyphs on company rows.
    const rowsWithoutIcons = seedDirectory.map(({ iconUrl: _drop, ...r }) => r);
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: {
          ...stubApi(),
          fetchChannelDirectory: async () => ({
            snapshot: true,
            cursor: "cur_company_icon_00000000000000000002",
            cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            rows: rowsWithoutIcons,
          }),
        },
        seedDirectory: rowsWithoutIcons,
        companies: [INDIGO, NOICON],
        self: { uid: "prs_stefan", displayName: "Stefan" },
        selectedId: "ch:chn_company_indigo",
      },
    });
    await vi.waitFor(() => {
      expect(mark("chn_company_indigo")).toBeTruthy();
    });
    expect(mark("chn_company_indigo")?.getAttribute("data-company-icon")).toBe(
      "glyph",
    );
    expect(mark("chn_company_noicon")?.getAttribute("data-company-icon")).toBe(
      "glyph",
    );
    expect(hash("chn_project")?.textContent).toBe("#");
  });
});
