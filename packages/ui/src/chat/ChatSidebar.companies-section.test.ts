// @vitest-environment happy-dom

/**
 * Regression tests for the sidebar "Companies" section click → open-home
 * path. Bug report: "when I click on the companies nothing is happening" —
 * clicking a company row in the "All" scope did nothing when its home
 * channel wasn't resolvable yet. Root cause: a company with no resolved
 * home row rendered as a plain, non-interactive `<div>` — a click there was
 * a structural no-op, not a bug in the open logic itself. These tests pin:
 *  - a resolved home channel opens on click (fires `onselect`);
 *  - an unresolved home channel is still clickable, retries resolution, and
 *    (on failure) leaves a `[companies] open-home-failed` log line instead
 *    of silently doing nothing (policy: never swallow errors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import ChatSidebar from "./ChatSidebar.svelte";
import type { ChatSidebarApi } from "./chat-api";
import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
import type { Workspace } from "./workspaces.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

installMemoryLocalStorage();

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

/** A second company whose home channel is NOT in the initial directory feed
 * (mirrors a company the directory hasn't synced yet). */
const STALLED: Workspace = {
  ...INDIGO,
  slug: "stalled",
  displayName: "Stalled Co",
  cloudUid: "cmp_stalled",
};

const homeChannelRow: ChannelDirectoryRow = {
  channelId: "chn_home_indigo",
  type: "chat",
  scope: "company",
  companyUid: "cmp_indigo",
  name: "indigo",
  lastActivityAt: now(),
  isCompanyHome: true,
};

function stubApi(overrides: Partial<ChatSidebarApi> = {}): ChatSidebarApi {
  return {
    fetchChannelDirectory: async () => ({
      snapshot: true,
      cursor: "cur_companies_section_0000000000000",
      cursorExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      rows: [homeChannelRow],
    }),
    listContacts: async () => ({ contacts: [] }),
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
  window.localStorage?.clear?.();
  vi.restoreAllMocks();
});

describe("ChatSidebar Companies section — click opens the home channel", () => {
  it("clicking a resolved company row opens its home channel, even outside that company's scope", async () => {
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO],
        // "All" scope — the reported repro state.
        scopeUid: "all",
        onselect,
      },
    });

    let row: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      row = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-cmp_indigo"]',
      );
      expect(row).toBeTruthy();
    });
    // Boot auto-selects the first conversation; isolate the explicit click.
    onselect.mockClear();

    row!.click();
    await tick();

    expect(onselect).toHaveBeenCalledTimes(1);
    const [openedRow, openOptions] = onselect.mock.calls[0]!;
    expect(openedRow.channelId).toBe("chn_home_indigo");
    expect(openOptions?.automatic).toBeFalsy();
  });

  it("a company with no resolved home channel yet is still clickable, and opens once resolution succeeds", async () => {
    const onselect = vi.fn();
    let attempts = 0;
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          listChannels: async () => {
            attempts += 1;
            // First (background) attempt: nothing yet. Second (click retry):
            // the channel has arrived.
            if (attempts < 2) return { channels: [] };
            return {
              channels: [
                {
                  channelId: "chn_home_stalled",
                  name: "stalled",
                  scope: "company",
                  companyUid: "cmp_stalled",
                  isCompanyHome: true,
                },
              ],
            };
          },
        }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, STALLED],
        scopeUid: "all",
        onselect,
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_stalled"]',
      );
      expect(disabledRow).toBeTruthy();
    });
    // Background resolver's first attempt already ran and found nothing —
    // the row must stay present (and clickable), never silently vanish.
    expect(disabledRow!.getAttribute("aria-disabled")).not.toBe("true");
    expect(disabledRow!.disabled).toBeFalsy();
    // Boot auto-selects the first conversation; isolate the explicit click.
    onselect.mockClear();

    disabledRow!.click();
    await vi.waitFor(() =>
      expect(
        onselect.mock.calls.some(([row]) => row.channelId === "chn_home_stalled"),
      ).toBe(true),
    );
  });

  it("logs a tagged, non-silent failure when a click's retry still can't resolve the home channel", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({
          listChannels: async () => ({ channels: [] }),
        }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, STALLED],
        scopeUid: "all",
        onselect,
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_stalled"]',
      );
      expect(disabledRow).toBeTruthy();
    });
    warnSpy.mockClear();
    // Boot auto-selects the first conversation; isolate the explicit click.
    onselect.mockClear();

    disabledRow!.click();
    await vi.waitFor(() => {
      const failedLine = warnSpy.mock.calls.find(([line]) =>
        typeof line === "string" && line.startsWith("[companies] open-home-failed"),
      );
      expect(failedLine).toBeTruthy();
    });

    // Never a silent no-op: the failed company's home channel never opens,
    // but the row itself reflects the failure (not just console noise) so a
    // user without devtools open still learns the click did something.
    expect(
      onselect.mock.calls.some(([row]) => row.channelId === "chn_home_stalled"),
    ).toBe(false);
    await vi.waitFor(() => {
      expect(disabledRow!.title).toMatch(/couldn't open/i);
    });
  });
});
