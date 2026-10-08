// @vitest-environment happy-dom

/**
 * Update-available toast (OWNER-003: moved from the sidebar card onto the
 * shared toast layer). Proves the sticky update toast is wired into DesktopApp: it appears on the deferred event and on mount when
 * the gate query returns a pending version, stays idempotent for repeated
 * events with the same version, respects holds, and snoozes the
 * version for the session when the person picks "Later".
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
  window.sessionStorage?.clear?.();
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
      document.querySelector('[data-testid="update-available-card"]'),
    ).toBeNull();

    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      document.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();
  });

  it("shows the card on mount when the gate query returns a pending version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host, gatePayload(VERSION_A));
    await settle(12);

    expect(queryUpdateGate).toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();
  });

  it("shows version text in the secondary line when no holds are active", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A, []));
    await settle();

    const secondary = document.querySelector('[data-testid="update-available-card"] [data-testid="toast-detail"]');
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

    const secondary = document.querySelector('[data-testid="update-available-card"] [data-testid="toast-detail"]');
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

    const button = document.querySelector<HTMLButtonElement>(
      '[data-testid="update-install"]',
    );
    expect(button?.disabled).toBe(true);
    expect(button?.title).toContain("HQ folder update");
  });

  it("re-enables the install button when the hold clears", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);

    // A hold that stops Restart. (An upload no longer does: #1237.)
    events.emit(
      "update-gate://deferred",
      gatePayload(VERSION_A, ["TranscriptFinishing"]),
    );
    await settle();
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
      "button disabled while hold is active",
    ).toBe(true);

    events.emit("update-gate://deferred", gatePayload(VERSION_A, []));
    await settle();
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
      "button enabled after hold clears",
    ).toBe(false);
  });

  it("calls installPendingUpdate when Restart is clicked", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    document
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
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    const errorEl = document.querySelector('[data-testid="update-available-card"] [data-testid="toast-error"]');
    expect(errorEl).not.toBeNull();
    // Server text is not shown; the toast uses plain copy (AUDIT-3c).
    expect(errorEl?.textContent).not.toContain("A recording is in progress");
    expect(errorEl?.textContent).toContain("Could not restart to update. Try again.");
  });

  it("never shows raw transport error text in the update toast", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockRejectedValueOnce(new Error(RAW));
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    const card = document.querySelector('[data-testid="update-available-card"]');
    const errorEl = card?.querySelector('[data-testid="toast-error"]');
    expect(errorEl?.textContent).toContain("Could not restart to update. Try again.");
    expect(card?.textContent).not.toContain("HTTP 500");
    expect(card?.textContent).not.toContain("boom");
    for (const el of Array.from(card?.querySelectorAll("[title]") ?? [])) {
      expect(el.getAttribute("title")).not.toContain("boom");
    }
    expect(warn.mock.calls.some((args) => args.some((a) => String(a).includes("boom")))).toBe(true);
    warn.mockRestore();
  });

  it("keeps the sidebar card in a recording-deferred state", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockResolvedValueOnce(
      failure("hold-active", "HQ will restart to update after your recording finishes"),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    expect(document.body.textContent).toContain("HQ will restart to update after your recording finishes");
    const button = document.querySelector<HTMLButtonElement>('[data-testid="update-install"]');
    expect(button?.textContent).toContain("Waiting to restart");
    expect(button?.disabled).toBe(true);
  });

  it("shows the Core update reason, not a recording, when Core holds the restart", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockResolvedValueOnce(
      failure("hold-active", "HQ will restart to update after the HQ Core update finishes"),
    );
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    expect(document.body.textContent).toContain("HQ will restart to update after the HQ Core update finishes");
    expect(document.body.textContent).not.toContain("recording");
  });

  it("re-enables the install button after an install error", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    installPendingUpdate.mockResolvedValueOnce(failure("hold-active", "Hold active"));
    document
      .querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
      .click();
    await settle();

    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!
        .disabled,
    ).toBe(false);
  });

  it("Later hides the card for that version", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      document.querySelector('[data-testid="update-available-card"]'),
    ).not.toBeNull();

    document
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    expect(
      document.querySelector('[data-testid="update-available-card"]'),
    ).toBeNull();
  });

  it("Later persists the dismissed version so repeated events don't re-show the card", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    document
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    expect(
      document.querySelector('[data-testid="update-available-card"]'),
      "same version must not re-show after Later",
    ).toBeNull();
  });

  it("a newer version re-shows the card after Later was clicked for the old one", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();

    document
      .querySelector<HTMLButtonElement>('[data-testid="update-later"]')!
      .click();
    await settle();

    events.emit("update-gate://deferred", gatePayload(VERSION_B));
    await settle();

    expect(
      document.querySelector('[data-testid="update-available-card"]'),
      "newer version shows again",
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="update-available-card"] [data-testid="toast-detail"]')?.textContent,
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

    const cards = document.querySelectorAll(
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
      document.querySelector('[data-testid="update-available-card"]'),
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
        document
          .querySelector('[data-testid="update-available-card"] [data-testid="toast-detail"]')
          ?.textContent?.trim(),
        `reason ${reason}`,
      ).toBe(expected);
      if (component) await unmount(component);
      component = null;
      host?.remove();
      resetSharedState();
    }
  });

  it("while a recording holds it, Restart is disabled, not drawn as primary, and says when it will work", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A, ["MeetingRecording"]));
    await settle();
    const install = document.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!;
    expect(install.disabled).toBe(true);
    expect(install.classList.contains("primary")).toBe(false);
    expect(install.getAttribute("title")).toBe(
      "Waiting for your recording to finish. Restart becomes available when it finishes.",
    );
  });

  it("an upload alone does not hold Restart (the rule from main, #1237)", async () => {
    // Sync is nearly always uploading. Holding Restart for it left people
    // unable to update at all. (This case used to assert Restart was disabled.)
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A, ["UploadInFlight"]));
    await settle();
    const install = document.querySelector<HTMLButtonElement>('[data-testid="update-install"]')!;
    expect(install.disabled).toBe(false);
    expect(install.classList.contains("primary")).toBe(true);
    expect(install.getAttribute("title")).toBeNull();
  });

  it("Later snoozes the version for this session only", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("update-gate://deferred", gatePayload(VERSION_A));
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="update-later"]')!.click();
    await settle();
    expect(document.querySelector('[data-testid="update-available-card"]')).toBeNull();
    expect(window.localStorage.getItem("hq.update.dismissedVersion")).toBeNull();

    // Same session, fresh window: still snoozed.
    if (component) await unmount(component);
    component = null;
    host.remove();
    await mountApp(events.host, gatePayload(VERSION_A));
    expect(document.querySelector('[data-testid="update-available-card"]')).toBeNull();

    // New session: the update is offered again.
    if (component) await unmount(component);
    component = null;
    host.remove();
    window.sessionStorage.clear();
    await mountApp(events.host, gatePayload(VERSION_A));
    expect(document.querySelector('[data-testid="update-available-card"]')).not.toBeNull();
  });

  it("shows one sync toast that fills while files move and goes quiet when done", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("sync:plan", { company: "Acme", filesToUpload: 4 });
    events.emit("sync:progress", { company: "Acme" });
    await settle();
    let toasts = document.querySelectorAll<HTMLElement>('[data-testid="sync-toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].dataset.kind).toBe("sticky");
    expect(toasts[0].textContent).toContain("1 of 4 done");
    expect(toasts[0].querySelector('[data-testid="toast-progress"]')?.getAttribute("aria-valuenow")).toBe("25");

    events.emit("sync:progress", { company: "Acme" });
    await settle();
    toasts = document.querySelectorAll<HTMLElement>('[data-testid="sync-toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].textContent).toContain("2 of 4 done");

    events.emit("sync:all-complete", {});
    await settle();
    toasts = document.querySelectorAll<HTMLElement>('[data-testid="sync-toast"]');
    expect(toasts).toHaveLength(1);
    expect(toasts[0].dataset.kind).toBe("quiet");
    expect(toasts[0].textContent).toContain("Files up to date");
  });
  function syncToasts(): NodeListOf<HTMLElement> {
    return document.querySelectorAll<HTMLElement>('[data-testid="sync-toast"]');
  }

  async function remount(events: ReturnType<typeof createSyncEventHost>): Promise<void> {
    if (component) await unmount(component);
    component = null;
    host.remove();
    await mountApp(events.host);
  }

  it("X keeps the sync toast hidden through later progress ticks, batches and the done notice", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("sync:plan", { company: "personal", filesToUpload: 1844 });
    events.emit("sync:progress", { company: "personal" });
    await settle();
    expect(syncToasts()).toHaveLength(1);
    expect(syncToasts()[0].textContent).toContain("Syncing 1844 files for Personal");

    syncToasts()[0].querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')!.click();
    await settle();
    expect(syncToasts()).toHaveLength(0);

    for (let i = 0; i < 5; i += 1) events.emit("sync:progress", { company: "personal" });
    events.emit("sync:plan", { company: "personal", filesToUpload: 20 });
    // Another company later in the same run stays hidden too.
    events.emit("sync:plan", { company: "Acme", filesToUpload: 3 });
    events.emit("sync:progress", { company: "Acme" });
    await settle();
    expect(syncToasts()).toHaveLength(0);

    events.emit("sync:all-complete", {});
    await settle();
    expect(syncToasts()).toHaveLength(0);
  });

  it("a dismissed company stays hidden on later runs and after a restart; other companies still show", async () => {
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("sync:plan", { company: "personal", filesToUpload: 10 });
    events.emit("sync:progress", { company: "personal" });
    await settle();
    syncToasts()[0].querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')!.click();
    await settle();
    events.emit("sync:all-complete", {});
    await settle();
    expect(window.localStorage.getItem("hq.work.tenant.v1.prs_me.all.hq.syncToast.dismissed.v1")).toBe('["personal"]');

    // Next run, same window.
    events.emit("sync:plan", { company: "personal", filesToUpload: 4 });
    events.emit("sync:progress", { company: "personal" });
    await settle();
    expect(syncToasts()).toHaveLength(0);
    events.emit("sync:all-complete", {});
    await settle();

    // Restart: the choice was saved, so the toast stays off for Personal.
    await remount(events);
    events.emit("sync:plan", { company: "personal", filesToUpload: 4 });
    events.emit("sync:progress", { company: "personal" });
    await settle();
    expect(syncToasts()).toHaveLength(0);
    events.emit("sync:all-complete", {});
    await settle();
    expect(syncToasts()).toHaveLength(0);

    // A company the person never closed still gets its toast.
    events.emit("sync:plan", { company: "Acme", filesToUpload: 2 });
    events.emit("sync:progress", { company: "Acme" });
    await settle();
    expect(syncToasts()).toHaveLength(1);
    expect(syncToasts()[0].textContent).toContain("1 of 2 done");
  });

  it("the saved dismissal belongs to the account that made it", async () => {
    window.localStorage.setItem("hq.work.tenant.v1.prs_other.all.hq.syncToast.dismissed.v1", '["personal"]');
    const events = createSyncEventHost();
    await mountApp(events.host);
    events.emit("sync:plan", { company: "personal", filesToUpload: 2 });
    events.emit("sync:progress", { company: "personal" });
    await settle();
    expect(syncToasts()).toHaveLength(1);
  });
});
