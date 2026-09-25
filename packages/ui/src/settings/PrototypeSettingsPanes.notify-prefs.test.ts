// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

const PREFS = {
  pausedUntil: null,
  dmsDuringPause: false,
  dms: true,
  mentions: true,
  files: true,
  allActivity: true,
  addedToChannel: true,
  updatedAt: "2026-09-23T19:19:03.904Z",
};

function makeAdapter(messaging: Record<string, unknown>, native: Record<string, unknown> = {}) {
  return {
    kind: "desktop",
    isAvailable: () => false,
    appShell: { notificationPermissionState: vi.fn(async () => ok("granted")) },
    meetings: { listAccounts: vi.fn(async () => ok([])) },
    settings: { getSettings: vi.fn(async () => ok(native)) },
    messaging,
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

function render(adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "notifications", adapter },
  });
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("Settings > Notifications server prefs", () => {
  it("loads prefs and renders pause choices and the six toggles", async () => {
    const getNotifyPrefs = vi.fn(async () => ok({ prefs: PREFS, paused: false }));
    render(makeAdapter({ getNotifyPrefs }));
    await vi.waitFor(() => expect(q("notify-pref-dms")).not.toBeNull());
    expect(getNotifyPrefs).toHaveBeenCalledTimes(1);
    for (const key of ["dms", "mentions", "files", "allActivity", "addedToChannel"]) {
      expect(q(`notify-pref-${key}`)?.getAttribute("aria-checked")).toBe("true");
    }
    expect(q("notify-pref-dmsDuringPause")?.getAttribute("aria-checked")).toBe("false");
    for (const id of ["off", "1h", "8h", "tomorrow", "forever"]) {
      expect(q(`notify-pause-${id}`)).not.toBeNull();
    }
    expect(q("notify-pause-off")?.getAttribute("aria-checked")).toBe("true");
    expect(q("notify-prefs-pause-status")?.textContent).toBe("Notifications are on");
    // The local master switch is still there.
    expect(host.querySelector('[aria-label="DM notifications"]')).not.toBeNull();
  });

  it("toggles optimistically and sends a partial PUT", async () => {
    let resolvePut!: (v: unknown) => void;
    const updateNotifyPrefs = vi.fn(
      () => new Promise((done) => (resolvePut = done)),
    );
    render(
      makeAdapter({
        getNotifyPrefs: async () => ok({ prefs: PREFS, paused: false }),
        updateNotifyPrefs,
      }),
    );
    await vi.waitFor(() => expect(q("notify-pref-files")).not.toBeNull());
    q("notify-pref-files")!.click();
    await tick();
    expect(updateNotifyPrefs).toHaveBeenCalledWith({ files: false });
    expect(q("notify-pref-files")?.getAttribute("aria-checked")).toBe("false");
    resolvePut(ok({ prefs: { ...PREFS, files: false }, paused: false }));
    await vi.waitFor(() =>
      expect(q("notify-pref-files")?.getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("rolls back a failed save and shows the error", async () => {
    render(
      makeAdapter({
        getNotifyPrefs: async () => ok({ prefs: PREFS, paused: false }),
        updateNotifyPrefs: async () => failure("http-500", "Server unavailable"),
      }),
    );
    await vi.waitFor(() => expect(q("notify-pref-mentions")).not.toBeNull());
    q("notify-pref-mentions")!.click();
    await vi.waitFor(() => expect(q("notify-prefs-save-error")).not.toBeNull());
    expect(q("notify-pref-mentions")?.getAttribute("aria-checked")).toBe("true");
    expect(q("notify-prefs-save-error")?.textContent).toBe("Server unavailable");
  });

  it("pauses indefinitely with pausedUntil forever", async () => {
    const updateNotifyPrefs = vi.fn(async () =>
      ok({ prefs: { ...PREFS, pausedUntil: "forever" }, paused: true }),
    );
    render(
      makeAdapter({
        getNotifyPrefs: async () => ok({ prefs: PREFS, paused: false }),
        updateNotifyPrefs,
      }),
    );
    await vi.waitFor(() => expect(q("notify-pause-forever")).not.toBeNull());
    q("notify-pause-forever")!.click();
    await vi.waitFor(() =>
      expect(q("notify-pause-forever")?.getAttribute("aria-checked")).toBe("true"),
    );
    expect(updateNotifyPrefs).toHaveBeenCalledWith({ pausedUntil: "forever" });
    expect(q("notify-prefs-pause-status")?.textContent).toBe("Paused until you turn it off");
  });

  it("sends an ISO Z instant for a timed pause", async () => {
    const updateNotifyPrefs = vi.fn(async (patch: { pausedUntil: string }) =>
      ok({ prefs: { ...PREFS, ...patch }, paused: true }),
    );
    render(
      makeAdapter({
        getNotifyPrefs: async () => ok({ prefs: PREFS, paused: false }),
        updateNotifyPrefs,
      }),
    );
    await vi.waitFor(() => expect(q("notify-pause-1h")).not.toBeNull());
    q("notify-pause-1h")!.click();
    await vi.waitFor(() => expect(updateNotifyPrefs).toHaveBeenCalled());
    const sent = updateNotifyPrefs.mock.calls[0]![0].pausedUntil;
    expect(sent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("handles a 404 from an older server without an error", async () => {
    render(
      makeAdapter({ getNotifyPrefs: async () => failure("http-404", "GET /v1/notify/prefs failed") }),
    );
    await vi.waitFor(() => expect(q("notify-prefs-unavailable")).not.toBeNull());
    expect(q("notify-pref-dms")).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("hides the prefs when the host has no prefs seam", async () => {
    render(makeAdapter({}));
    await vi.waitFor(() => expect(q("notify-prefs-unavailable")).not.toBeNull());
  });

  it("explains that the local DM switch overrides everything on this Mac", async () => {
    render(
      makeAdapter(
        { getNotifyPrefs: async () => ok({ prefs: PREFS, paused: false }) },
        { dmNotifications: false },
      ),
    );
    await vi.waitFor(() => expect(q("notify-prefs-master-off")).not.toBeNull());
  });
});
