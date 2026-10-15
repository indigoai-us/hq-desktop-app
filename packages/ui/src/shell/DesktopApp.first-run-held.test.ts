// @vitest-environment happy-dom

/**
 * US-010: no bare shell during first run.
 *
 * While the first-run route is pending (or visual and the takeover has not
 * opened) the shell's pages are held and the takeover's backdrop paints. The
 * welcome window's handoff hint settles the route on the first frame (no 2 s
 * status wait), and the host hears once when the first screen is painted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, VISUAL_FIRST_RUN_FLAG, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import type { FirstRunHandoffHint } from "../chat/first-run/first-run-handoff.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  document
    .querySelectorAll('[data-testid="first-run-takeover"], [data-testid="first-run-held"]')
    .forEach((el) => el.remove());
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const never = <T,>() => new Promise<T>(() => undefined);

interface Options {
  hasFeature: (name: string) => Promise<unknown>;
  getSetupStatus: () => Promise<unknown>;
}

function makeAdapter({ hasFeature, getSetupStatus }: Options) {
  const hasFeatureSpy = vi.fn(hasFeature);
  const getSetupStatusSpy = vi.fn(getSetupStatus);
  const adapter = {
    kind: "desktop",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      listChannelMembers: async () => ok({ members: [] }),
      fetchChannel: async () => ({ ok: false as const, reason: "unavailable" }),
      fetchDmThread: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    files: { listDir: async () => ok([]) },
    identity: { hasFeature: hasFeatureSpy },
    bots: {
      list: async () => ok({ bots: [] }),
      listRemote: async () => ok({ bots: [] }),
      create: async () => ok({ ok: true, name: "setup", agentUid: "agt_setup_held" }),
      start: async () => ok({}),
      stop: async () => ok({}),
      remove: async () => ok({}),
      workers: async () => ok({ workers: [] }),
      probe: async () => ok({ ok: true, class: null }),
    },
    appShell: { setActiveCompany: async () => ok(undefined) },
    settings: {
      getSetupStatus: getSetupStatusSpy,
      markWelcomeTourShown: async () => ok(undefined),
    },
    shell: {
      detectAiTools: async () => ({ ok: false as const, reason: "unavailable" }),
    },
    sessions: {
      preflight: async () =>
        ok({
          claudeAvailable: true,
          claudeLoggedIn: true,
          codexAvailable: false,
          codexLoggedIn: false,
          grokAvailable: false,
          grokLoggedIn: false,
        }),
    },
  } as unknown as PlatformAdapter;
  return { adapter, hasFeatureSpy, getSetupStatusSpy };
}

function mountShell(
  adapter: PlatformAdapter,
  extra: { firstRunHandoff?: FirstRunHandoffHint | null; onFirstRunPainted?: () => void } = {},
): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter,
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: { uid: "prs_test", displayName: "Ada Lovelace", email: "ada@example.com" },
      coreFixtures: false,
      ...extra,
    },
  });
}

const HINT_VISUAL: FirstRunHandoffHint = {
  route: null,
  flags: { visualFirstRun: true, foundApps: false },
  welcomeSetupOwed: true,
  welcomeTourShown: false,
};

describe("first run holds the shell", () => {
  it("renders the takeover backdrop and not the shell's default page while the route is pending", async () => {
    const { adapter } = makeAdapter({ hasFeature: () => never(), getSetupStatus: () => never() });
    mountShell(adapter);
    await settle();

    expect(q("first-run-held")).toBeTruthy();
    expect(q("first-run-held-page")).toBeTruthy();
    expect(q("channel-loading")).toBeNull();
    expect(q("first-run-takeover")).toBeNull();
  });

  it("shows the shell's page once the route settles on the ordinary shell", async () => {
    const { adapter } = makeAdapter({
      hasFeature: async () => ok(false),
      getSetupStatus: async () => ok({ hqRootValid: true, configured: true, welcomeSetupOwed: true }),
    });
    mountShell(adapter);
    await vi.waitFor(() => expect(q("first-run-held")).toBeNull(), { timeout: 1000, interval: 20 });
    expect(q("first-run-held-page")).toBeNull();
  });

  it("opens the takeover from the handoff hint with no flag read and no 2 s status wait", async () => {
    // Neither the flag service nor the setup status ever answers: without the
    // hint the route would wait 2 s for the status and then fall back.
    const { adapter, hasFeatureSpy } = makeAdapter({ hasFeature: () => never(), getSetupStatus: () => never() });
    const started = Date.now();
    mountShell(adapter, { firstRunHandoff: HINT_VISUAL });
    await vi.waitFor(() => expect(q("first-run-takeover")).toBeTruthy(), { timeout: 1000, interval: 10 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hasFeatureSpy).not.toHaveBeenCalledWith(VISUAL_FIRST_RUN_FLAG);
    expect(q("first-run-held")).toBeNull();
  });

  it("tells the host once when the takeover is painted", async () => {
    const { adapter } = makeAdapter({ hasFeature: () => never(), getSetupStatus: () => never() });
    const onFirstRunPainted = vi.fn();
    mountShell(adapter, { firstRunHandoff: HINT_VISUAL, onFirstRunPainted });
    await vi.waitFor(() => expect(q("first-run-takeover")).toBeTruthy(), { timeout: 1000, interval: 10 });
    await vi.waitFor(() => expect(onFirstRunPainted).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 10 });
    await new Promise((r) => setTimeout(r, 120));
    expect(onFirstRunPainted).toHaveBeenCalledTimes(1);
  });

  it("tells the host when the ordinary shell is painted and the takeover is off", async () => {
    const { adapter } = makeAdapter({ hasFeature: () => never(), getSetupStatus: () => never() });
    const onFirstRunPainted = vi.fn();
    mountShell(adapter, {
      firstRunHandoff: { ...HINT_VISUAL, flags: { visualFirstRun: false, foundApps: null } },
      onFirstRunPainted,
    });
    await vi.waitFor(() => expect(onFirstRunPainted).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 10 });
    expect(q("first-run-takeover")).toBeNull();
    expect(q("first-run-held")).toBeNull();
  });
});
