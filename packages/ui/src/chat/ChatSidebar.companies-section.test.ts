// @vitest-environment happy-dom

/**
 * Regression tests for the sidebar "Companies" section click → open-home
 * path. Bug report: "when I click on the companies nothing is happening" —
 * clicking a company row in the "All" scope did nothing when its home
 * channel wasn't resolvable yet.
 *
 * The company's home channel id (`Workspace.homeChannelId`) normally comes
 * straight from the roster — no client-side name/scope matching. When it's
 * missing (a new/legacy company still provisioning server-side), the click
 * calls the idempotent `ensureCompanyHomeChannel` endpoint (`POST
 * /v1/companies/{uid}/home-channel`) instead of any client-side resolution.
 * These tests pin:
 *  - a home channel already loaded in the sidebar opens on click (fires
 *    `onselect`);
 *  - a home channel NOT yet loaded (e.g. the "All" scope) still opens, via
 *    the generic "open a channel by id" path (`requestChannelOpen`) that
 *    notifications and deep links use;
 *  - a company with no `homeChannelId` calls `ensureCompanyHomeChannel` on
 *    click, shows a subtle loading state while in flight, then opens the
 *    returned channel;
 *  - a failed `ensureCompanyHomeChannel` call retries automatically (with
 *    backoff, up to 3 attempts total) and logs each attempt via
 *    `[companies] open-failed company=<slug> attempt=<n>/3 reason=<...>` —
 *    never a silent no-op;
 *  - once retries are exhausted, Corey's product rule (never a raw red
 *    error, always a heal path) means the row shows a quiet "Tap to retry"
 *    hint — never the raw error text — and stays clickable so a click
 *    re-runs the ensure attempt from scratch;
 *  - with no `ensureCompanyHomeChannel` seam at all, the row stays disabled
 *    and a click logs `[companies] open-disabled …`.
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
  homeChannelId: "chn_home_indigo",
};

/** A second company whose home channel is NOT in the initial directory feed
 * (mirrors a company the directory hasn't synced that channel yet), but
 * WHOSE id the roster already knows — no resolution needed, just navigation. */
const STALLED: Workspace = {
  ...INDIGO,
  slug: "stalled",
  displayName: "Stalled Co",
  cloudUid: "cmp_stalled",
  homeChannelId: "chn_home_stalled",
};

/** A third company with no home channel yet at all (new/legacy company still
 * provisioning server-side). */
const PROVISIONING: Workspace = {
  ...INDIGO,
  slug: "provisioning",
  displayName: "Provisioning Co",
  cloudUid: "cmp_provisioning",
  homeChannelId: null,
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
    logToFile: async () => {},
    ensureCompanyHomeChannel: async (companyUid: string) => ({ homeChannelId: `chn_home_${companyUid}` }),
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

  it("a company whose home channel isn't loaded yet still opens on click, via the generic open-by-id path", async () => {
    const onselect = vi.fn();
    const openSpy = vi.fn();
    window.addEventListener("hq:open-channel", (e) =>
      openSpy((e as CustomEvent).detail),
    );
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi(),
        // Only Indigo's home channel is in the loaded directory feed —
        // Stalled Co's home channel id is known from the roster, but the
        // channel itself hasn't synced into this sidebar's rows yet.
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, STALLED],
        scopeUid: "all",
        onselect,
      },
    });

    let row: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      row = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-cmp_stalled"]',
      );
      expect(row).toBeTruthy();
    });
    onselect.mockClear();

    row!.click();
    await tick();

    // Not resolved through onselect (no local row) — instead the generic
    // "open a channel by id" event fires with the roster's homeChannelId,
    // the same path deep links and notifications use.
    expect(openSpy).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "chn_home_stalled" }),
    );
  });

  it("ensureCompanyHomeChannel and logToFile are required: a no-homeChannelId row still attempts ensure on click, never silently disables", async () => {
    const logSpy = vi.fn(async () => undefined);
    const ensureSpy = vi.fn(async () => {
      throw new Error("server unreachable");
    });
    const onselect = vi.fn();
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({ logToFile: logSpy, ensureCompanyHomeChannel: ensureSpy }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, PROVISIONING],
        scopeUid: "all",
        onselect,
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_provisioning"]',
      );
      expect(disabledRow).toBeTruthy();
    });
    expect(disabledRow!.title).toBe("No company channel yet");
    onselect.mockClear();
    logSpy.mockClear();

    disabledRow!.click();
    await vi.waitFor(
      () => {
        expect(ensureSpy).toHaveBeenCalledWith("cmp_provisioning");
        expect(logSpy).toHaveBeenCalledWith(
          "companies",
          expect.stringMatching(
            /^open-failed company=provisioning attempt=1\/3 reason=server unreachable$/,
          ),
        );
      },
      { timeout: 3000 },
    );
    expect(onselect).not.toHaveBeenCalled();
  });

  it("a no-homeChannelId row calls ensureCompanyHomeChannel on click, shows a loading state, then opens the returned channel", async () => {
    const onselect = vi.fn();
    const openSpy = vi.fn();
    window.addEventListener("hq:open-channel", (e) =>
      openSpy((e as CustomEvent).detail),
    );
    let resolveEnsure!: (v: { homeChannelId: string }) => void;
    const ensureCompanyHomeChannel = vi.fn(
      () => new Promise<{ homeChannelId: string }>((resolve) => (resolveEnsure = resolve)),
    );
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({ ensureCompanyHomeChannel }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, PROVISIONING],
        scopeUid: "all",
        onselect,
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_provisioning"]',
      );
      expect(disabledRow).toBeTruthy();
    });

    disabledRow!.click();
    expect(ensureCompanyHomeChannel).toHaveBeenCalledWith("cmp_provisioning");
    // Loading state while in flight — never a name/scope-matched heuristic.
    await vi.waitFor(() => expect(disabledRow!.getAttribute("aria-busy")).toBe("true"));

    resolveEnsure({ homeChannelId: "chn_home_provisioning" });
    await vi.waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: "chn_home_provisioning" }),
      ),
    );
    // The row is no longer disabled once it has a resolved homeChannelId.
    await vi.waitFor(() =>
      expect(
        host.querySelector('[data-testid="chat-companies-row-disabled-cmp_provisioning"]'),
      ).toBeNull(),
    );
  });

  it("a failed ensureCompanyHomeChannel call retries with backoff, then shows a quiet heal hint — never the raw error text", async () => {
    const logSpy = vi.fn(async () => undefined);
    const ensureCompanyHomeChannel = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({ ensureCompanyHomeChannel, logToFile: logSpy }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, PROVISIONING],
        scopeUid: "all",
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_provisioning"]',
      );
      expect(disabledRow).toBeTruthy();
    });
    logSpy.mockClear();

    disabledRow!.click();

    // Retries 3 times total, with backoff, before giving up.
    await vi.waitFor(
      () => expect(ensureCompanyHomeChannel).toHaveBeenCalledTimes(3),
      { timeout: 3000 },
    );
    for (const attempt of [1, 2, 3]) {
      expect(logSpy).toHaveBeenCalledWith(
        "companies",
        `open-failed company=provisioning attempt=${attempt}/3 reason=upstream unavailable`,
      );
    }

    // Corey's product rule: never a raw red error, always a heal path. The
    // row's tooltip and inline hint are a quiet, neutral "tap to retry" —
    // never the raw server/error text.
    await vi.waitFor(() => expect(disabledRow!.title).toBe("Tap to retry"));
    expect(disabledRow!.title).not.toMatch(/upstream unavailable/);
    expect(host.textContent).not.toMatch(/upstream unavailable/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const status = host.querySelector(
      '[data-testid="chat-companies-row-status-cmp_provisioning"]',
    );
    expect(status?.textContent?.trim()).toBe("Tap to retry");

    // The row stays clickable — a click is the heal path, re-running ensure.
    logSpy.mockClear();
    ensureCompanyHomeChannel.mockClear();
    disabledRow!.click();
    await vi.waitFor(() => expect(ensureCompanyHomeChannel).toHaveBeenCalledWith("cmp_provisioning"));
  });

  it("retries an AUTH_REQUIRED failure and succeeds once the token has refreshed", async () => {
    const openSpy = vi.fn();
    window.addEventListener("hq:open-channel", (e) =>
      openSpy((e as CustomEvent).detail),
    );
    let callCount = 0;
    const ensureCompanyHomeChannel = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("AUTH_REQUIRED: home-channel (HTTP 401 Unauthorized)");
      }
      return { homeChannelId: "chn_home_provisioning" };
    });
    component = mount(ChatSidebar, {
      target: host,
      props: {
        api: stubApi({ ensureCompanyHomeChannel }),
        seedDirectory: [homeChannelRow],
        companies: [INDIGO, PROVISIONING],
        scopeUid: "all",
      },
    });

    let disabledRow: HTMLButtonElement | null = null;
    await vi.waitFor(() => {
      disabledRow = host.querySelector<HTMLButtonElement>(
        '[data-testid="chat-companies-row-disabled-cmp_provisioning"]',
      );
      expect(disabledRow).toBeTruthy();
    });

    disabledRow!.click();

    await vi.waitFor(
      () =>
        expect(openSpy).toHaveBeenCalledWith(
          expect.objectContaining({ channelId: "chn_home_provisioning" }),
        ),
      { timeout: 3000 },
    );
    expect(ensureCompanyHomeChannel).toHaveBeenCalledTimes(2);
    // Never surfaced as a raw error at any point during the retry.
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
