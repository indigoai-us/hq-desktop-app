// @vitest-environment happy-dom

/**
 * US-008: hq://brief and hq://vault select the Daily Brief and the rail's
 * Files page. The desktop host turns each link into the embedded target below
 * (apps/sync desktopRouteToEmbeddedTarget, covered in route.test.ts); these
 * tests drive that target into the real shell and assert the view and the
 * rail selection match a rail click.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { loadBrief } from "./brief-lazy.js";
import {
  dispatchEmbeddedNavigation,
  type EmbeddedNavigationTarget,
} from "./embedded-navigation.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { BRIEF_OPEN_TOOL_KEY } from "../brief/brief-open-tool.js";

/** The targets hq://brief and hq://vault resolve to in the desktop host. */
const HQ_BRIEF_TARGET: EmbeddedNavigationTarget = { kind: "extra", page: "rail-brief" };
const HQ_VAULT_TARGET: EmbeddedNavigationTarget = { kind: "extra", page: "rail-library" };

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
    },
    marketplace: {
      listListings: async () => ok({ listings: [] }),
    },
    meetings: {
      listAccounts: async () => ok([]),
      permissionsState: async () => ok(null),
    },
    identity: {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: async () => ok(false),
      subscribeFeature: () => () => {},
    },
    appShell: {
      notificationPermissionState: async () => ok("default"),
    },
    settings: {
      getSettings: async () => ok({}),
    },
    library: {
      getRoot: async () => ok({ workers: [], skills: [] }),
      getCompany: async () => ok({ workers: [], skills: [] }),
      getWorkerDetail: async () => ok({}),
      getSkillDetail: async () => ok({}),
    },
  } as unknown as PlatformAdapter;
}

function localFilesAdapter(): PlatformAdapter {
  return {
    ...webAdapter(),
    files: {
      listDir: async () => ok([]),
      getFileContent: async () => ok(""),
      vault: {
        summary: async (root: string) =>
          ok({ root, notes: 0, files: 0, links: 0, truncated: false, hubs: [], folders: [] }),
        search: async () => ok([]),
        noteLinks: async () => ok({ resolved: [], backlinks: [], backlinkCount: 0, outgoing: [] }),
        readNote: async () => ok({ text: "", size: 0, truncated: false }),
      },
    },
  } as unknown as PlatformAdapter;
}

/** Turns the Daily Brief gate on, as the rail tests do. */
function withBriefGate(adapter: PlatformAdapter): PlatformAdapter {
  (adapter as unknown as { identity: unknown }).identity = {
    whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
    hasFeature: async (flag: string) => ok(flag === "desktop.rail-brief-v1"),
    subscribeFeature: () => () => {},
  };
  return adapter;
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

async function settle(): Promise<void> {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

async function mountShell(adapter: PlatformAdapter): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Stefan Johnson", email: "stefan@example.com" },
      coreFixtures: false,
    },
  });
  await settle();
}

function current(): string | null {
  return (
    host
      .querySelector('[data-testid="app-rail"] [aria-current="page"]')
      ?.getAttribute("data-rail-id") ?? null
  );
}

describe("DesktopApp hq:// links (US-008)", () => {
  it("a Continue choice opens that tool later from the Daily Brief, and not the other tool", async () => {
    window.localStorage.setItem(BRIEF_OPEN_TOOL_KEY, "codex");
    const launchClaudeCode = vi.fn(async () => ok(undefined));
    const launchCodexWorkspace = vi.fn(async () => ok(undefined));
    const adapter = withBriefGate(webAdapter());
    (adapter as unknown as { settings: unknown }).settings = {
      getSettings: async () => ok({}),
      getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }),
    };
    (adapter as unknown as { shell: unknown }).shell = {
      detectAiTools: async () =>
        ok({ claude_cli: true, claude_desktop: false, codex_cli: false, codex_desktop: true, grok_cli: false, any: true }),
      launchClaudeCode,
      launchCodexWorkspace,
      launchCliInTerminal: async () => ok(undefined),
      openClaudeCodeLink: async () => ok(undefined),
    };
    await mountShell(adapter);
    dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
    await settle();
    const button = host.querySelector<HTMLButtonElement>('[data-testid="brief-open-tool-button"]');
    expect(button?.textContent?.trim()).toBe("Open Codex");
    button!.click();
    await vi.waitFor(() => expect(launchCodexWorkspace).toHaveBeenCalledWith("/tmp/HQ"));
    expect(launchClaudeCode).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="welcome-report"]')).toBeNull();
  });

  it("hq://brief opens the Daily Brief with the rail on Brief", async () => {
    await mountShell(withBriefGate(webAdapter()));
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
    await settle();
    expect(host.querySelector('[data-testid="brief-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="rail-files-host"]')).toBeNull();
    expect(current()).toBe("brief");
    await loadBrief();
    await settle();
  });

  it("a cold-start hq://brief waits for the gates instead of redirecting to Messages", async () => {
    const pending: Array<() => void> = [];
    let briefOpen = true;
    const adapter = webAdapter();
    (adapter as unknown as { identity: unknown }).identity = {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: (flag: string) =>
        new Promise((resolve) => {
          pending.push(() => resolve(ok(flag === "desktop.rail-brief-v1" && briefOpen)));
        }),
      subscribeFeature: () => () => {},
    };
    await mountShell(adapter);
    dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
    await settle();
    // The gates have not answered: the link is held, not bounced to Messages.
    expect(pending.length).toBeGreaterThan(0);
    for (const answer of pending.splice(0)) answer();
    await settle();
    expect(host.querySelector('[data-testid="brief-host"]')).not.toBeNull();
    expect(current()).toBe("brief");
    await loadBrief();
    await settle();

    // Same race, gate answered off: the redirect still runs once it is known.
    await unmount(component!);
    component = null;
    host.remove();
    briefOpen = false;
    await mountShell(adapter);
    dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
    await settle();
    for (const answer of pending.splice(0)) answer();
    await settle();
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    expect(current()).not.toBeNull();
    expect(current()).not.toBe("brief");
  });

  it("a cold-start hq://brief whose gates never answer opens Home after 10 s and logs a [first-run] line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = webAdapter();
    (adapter as unknown as { identity: unknown }).identity = {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: () => new Promise(() => undefined),
      subscribeFeature: () => () => {},
    };
    await mountShell(adapter);
    vi.useFakeTimers();
    try {
      dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
      await vi.advanceTimersByTimeAsync(9_000);
      // Still held on the link: no redirect yet.
      expect(current()).toBeNull();
      expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[first-run] hq://brief"))).toBe(false);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[first-run] hq://brief gates did not answer"))).toBe(true);
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    expect(current()).not.toBeNull();
    expect(current()).not.toBe("brief");
  });

  it("a later hq://brief whose gates still hang gets its own 10 s wait", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = webAdapter();
    (adapter as unknown as { identity: unknown }).identity = {
      whoami: async () => ok({ personUid: "prs_fixture", email: "" }),
      hasFeature: () => new Promise(() => undefined),
      subscribeFeature: () => () => {},
    };
    await mountShell(adapter);
    warn.mockClear();
    const gateLogs = () =>
      warn.mock.calls.filter((c) => String(c[0]).startsWith("[first-run] hq://brief gates did not answer")).length;
    vi.useFakeTimers();
    try {
      dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
      await vi.advanceTimersByTimeAsync(10_500);
      expect(gateLogs()).toBe(1);
      expect(current()).not.toBeNull();
      dispatchEmbeddedNavigation(HQ_BRIEF_TARGET);
      await vi.advanceTimersByTimeAsync(9_000);
      // The second request is held for its own wait, not redirected at once.
      expect(current()).toBeNull();
      expect(gateLogs()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_500);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(gateLogs()).toBe(2);
    expect(current()).not.toBeNull();
    expect(current()).not.toBe("brief");
  });

  it("hq://vault opens the Files page with the rail on Files", async () => {
    await mountShell(localFilesAdapter());
    expect(host.querySelector('[data-testid="rail-files-host"]')).toBeNull();
    dispatchEmbeddedNavigation(HQ_VAULT_TARGET);
    await settle();
    expect(host.querySelector('[data-testid="rail-files-host"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="brief-host"]')).toBeNull();
    expect(current()).toBe("library");
  });
});
