// @vitest-environment happy-dom

/**
 * Sidebar update-available card. Proves the UpdateAvailableCard is correctly
 * wired into DesktopApp: it appears on the deferred event and on mount when
 * the gate query returns a pending version, stays idempotent for repeated
 * events with the same version, respects holds, and persists the user's
 * "Later" choice per-version.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, failure, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import { createChatWakeBus } from "../chat/chat-api.js";
import { takePendingConversation } from "../chat/pending-conversation.js";
import { takePendingChannelOpen } from "../chat/open-target.js";

const SELF = { uid: "prs_me", displayName: "Ada Lovelace", email: "ada@x.y" };
const VERSION_A = "1.2.3";
const VERSION_B = "1.2.4";

type Listener = (event: { payload?: unknown }) => void;

function createSyncEventHost() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    host: {
      listen: async (event: string, handler: Listener) => {
        const set = listeners.get(event) ?? new Set<Listener>();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
    },
    emit(event: string, payload?: unknown) {
      for (const handler of listeners.get(event) ?? []) handler({ payload });
    },
  };
}

function gatePayload(version: string | null, reasons: string[] = []) {
  return { pendingVersion: version, decision: "Defer", reasons, focused: true };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let queryUpdateGate: ReturnType<typeof vi.fn>;
let installPendingUpdate: ReturnType<typeof vi.fn>;

function buildAdapter(initialGatePayload = gatePayload(null)): PlatformAdapter {
  queryUpdateGate = vi.fn(async () => ok(initialGatePayload));
  installPendingUpdate = vi.fn(async () => ok(undefined));
  return {
    kind: "desktop",
    isAvailable: (cap: string) => cap === "canSync" || cap === "canSelfUpdate",
    capabilities: { canSync: true },
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok({ messages: [], nextCursor: null }),
      fetchDmThread: async () => ok({ messages: [], nextCursor: null }),
      listChannelMembers: async () => ok({ members: [] }),
    },
    sync: {
      startSync: async () => ok(undefined),
      getSyncStatus: async () =>
        ok({
          lastSyncAt: null,
          pendingFiles: 0,
          conflicts: 0,
          daemonRunning: true,
          source: "journal",
          hqFolderPath: "/tmp/hq",
        }),
    },
    updates: {
      checkForUpdates: async () => ok({}),
      availableChannels: async () => ok([]),
      queryUpdateGate,
      installPendingUpdate,
    },
  } as unknown as PlatformAdapter;
}

function resetSharedState(): void {
  window.localStorage?.clear?.();
  takePendingConversation();
  takePendingChannelOpen();
}

beforeEach(resetSharedState);
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetSharedState();
});

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await tick();
    await Promise.resolve();
  }
}

async function mountApp(
  syncEvents: ReturnType<typeof createSyncEventHost>["host"] | null = null,
  initialGate = gatePayload(null),
): Promise<void> {
  host = document.createElement("div");
  host.className = "desktop-shell chat-shell";
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: buildAdapter(initialGate),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      wakes: createChatWakeBus(),
      self: SELF,
      companies: null,
      syncEvents,
      coreFixtures: false,
    },
  });
  await settle();
}

describe("DesktopApp update-available card", () => {
  it("shows the card when the deferred event arrives with a pending version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).toBeNull();

    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();
  });

  it("shows the card on mount when the gate query returns a pending version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host, gatePayload(VERSION_A));
    await settle(12);

    expect(queryUpdateGate).toHaveBeenCalled();
    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();
  });

  it("shows version text in the secondary line when no holds are active", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A, []));
    await settle();

    const secondary = host.querySelector('[data-testid="update-secondary"]');
    expect(secondary?.textContent?.trim()).toContain(VERSION_A);
    expect(secondary?.textContent).toContain("ready to install");
  });

  it("shows the hold reason in the secondary line when a hold is active", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit(
      "update-gate://deferred",
      gatePayload(VERSION_A, ["MeetingRecording"]),
    );
    await settle();

    const secondary = host.querySelector('[data-testid="update-secondary"]');
    expect(secondary?.textContent?.trim()).toBe(
      "Waiting for your recording to finish",
    );
  });

  it("disables the install button when a hold reason is present", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit(
      "update-gate://deferred",
      gatePayload(VERSION_A, ["CoreUpdateInProgress"]),
    );
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="update-install"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.title).toContain("HQ folder update");
  });

  it("re-enables the install button when the hold clears", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);

    events.emit(
      "update-gate://deferred",
      gatePayload(VERSION_A, ["UploadInFlight"]),
    );
    await settle();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
      "button disabled while hold is active",
    ).toBe(true);

    events.emit("update-gate://deferred", gatePayload(VERSION_A, []));
    await settle();
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
      "button enabled after hold clears",
    ).toBe(false);
  });

  it("calls installPendingUpdate when Restart is clicked", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    host
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    expect(installPendingUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows the error inline when installPendingUpdate fails", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockResolvedValueOnce(
      failure("hold-active", "A recording is in progress"),
    );
    host
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    const errorEl = host.querySelector('[data-testid="update-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("A recording is in progress");
  });

  it("re-enables the install button after an install error", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockResolvedValueOnce(failure("hold-active", "Hold active"));
    host
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
    ).toBe(false);
  });

  it("Later hides the card for that version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();

    host
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).toBeNull();
  });

  it("Later persists the dismissed version so repeated events don't re-show the card", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    host
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
      "same version must not re-show after Later",
    ).toBeNull();
  });

  it("a newer version re-shows the card after Later was clicked for the old one", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    host
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    events.emit("update-gate://deferred", gatePayload(VERSION_B));
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
      "newer version shows again",
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="update-secondary"]')?.textContent,
    ).toContain(VERSION_B);
  });

  it("idempotent: repeated events with the same version do not add multiple cards", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);

    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    const cards = host.querySelectorAll(
      '[data-testid="update-available-card"]',
    );
    expect(cards).toHaveLength(1);
  });

  it("no card when the event carries a null version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(null));
    await settle();

    expect(
      host.querySelector('[data-testid="update-available-card"]'),
    ).toBeNull();
  });

  it("hold reason text varies by reason type", async () => {
    const cases: [string, string][] = [
      ["TranscriptFinishing", "Waiting for a transcript to finish"],
      ["UploadInFlight", "Waiting for an upload to finish"],
      [
        "CoreUpdateInProgress",
        "Waiting for the HQ folder update to finish",
      ],
    ];
    for (const [reason, expected] of cases) {
      const events = createSyncEventHost();
      await mountApp(events.host);
      events.emit("update-gate://deferred", gatePayload(VERSION_A, [reason]));
      await settle();
      expect(
        host
          .querySelector('[data-testid="update-secondary"]')
          ?.textContent?.trim(),
        `reason ${reason}`,
      ).toBe(expected);
      if (component) await unmount(component);
      component = null;
      host?.remove();
      resetSharedState();
    }
  });
});
