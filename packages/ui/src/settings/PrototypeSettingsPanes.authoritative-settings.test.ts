// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import type { Workspace } from "../chat/workspaces";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapterForSettings(options: {
  getSettings: PlatformAdapter["settings"]["getSettings"];
  updateSettings?: PlatformAdapter["settings"]["updateSettings"];
  notificationPermissionState?: PlatformAdapter["appShell"]["notificationPermissionState"];
  openNotificationSettings?: PlatformAdapter["appShell"]["openNotificationSettings"];
  requestNotificationPermission?: PlatformAdapter["appShell"]["requestNotificationPermission"];
  canSync?: boolean;
  canTray?: boolean;
  canWatchMeetings?: boolean;
}) {
  const openNotificationSettings = vi.fn(
    options.openNotificationSettings ?? (async () => ok(undefined)),
  );
  const requestNotificationPermission = vi.fn(
    options.requestNotificationPermission ?? (async () => ok("granted")),
  );
  const updateSettings = vi.fn(
    options.updateSettings ?? (async () => ok(undefined)),
  );
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) =>
      (capability === "canSync" && Boolean(options.canSync)) ||
      (capability === "trayAndWindow" && Boolean(options.canTray)) ||
      (capability === "canLaunchApps" && Boolean(options.canWatchMeetings)),
    settings: {
      getSettings: options.getSettings,
      updateSettings,
      getConfig: async () => ok({}),
    },
    appShell: {
      notificationPermissionState:
        options.notificationPermissionState ?? (async () => ok("granted")),
      openNotificationSettings,
      requestNotificationPermission,
    },
    meetings: { listAccounts: async () => ok([]) },
    sync: { getSyncStatus: async () => ok({}) },
  } as unknown as PlatformAdapter;
  return { adapter, updateSettings, openNotificationSettings, requestNotificationPermission };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

function mountPane(
  section: "meetings" | "notifications",
  adapter: PlatformAdapter,
  companies: Workspace[] | null = null,
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section, adapter, companies },
  });
}

describe("PrototypeSettingsPanes authoritative native settings", () => {
  it("keeps a stored recording company pending until memberships settle instead of calling it Personal", async () => {
    const { adapter, updateSettings } = adapterForSettings({
      getSettings: async () => ok({ defaultRecordingCompanyUid: "co_pending" }),
      canWatchMeetings: true,
    });
    mountPane("meetings", adapter, null);

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="recording-company-membership-pending"]'),
      ).not.toBeNull();
    });
    expect(host.textContent).not.toContain("Personal");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("shows Personal only after a successful native read and settled empty memberships", async () => {
    const { adapter } = adapterForSettings({
      getSettings: async () => ok({ defaultRecordingCompanyUid: null }),
    });
    mountPane("meetings", adapter, []);

    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="recording-company-personal"]')?.textContent,
      ).toBe("Personal");
    });
  });

  it("invalidates a focus read that resolves after a native setting write", async () => {
    const focusRead = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    const write = deferred<ReturnType<typeof ok<void>>>();
    let reads = 0;
    const { adapter, updateSettings } = adapterForSettings({
      getSettings: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve(ok({ notifications: true }));
        if (reads === 2) return focusRead.promise;
        return Promise.resolve(ok({ notifications: false }));
      },
      updateSettings: () => write.promise,
      canSync: true,
    });
    mountPane("notifications", adapter);
    await vi.waitFor(() => expect(reads).toBe(1));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(reads).toBe(2));
    host.querySelector<HTMLButtonElement>('[aria-label="Meeting notifications"]')?.click();
    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ notifications: false }),
    );

    // This stale focus response says "true", but write invalidation means it
    // cannot undo the newer optimistic/native value.
    focusRead.resolve(ok({ notifications: true }));
    write.resolve(ok(undefined));
    await Promise.all([focusRead.promise, write.promise]);
    await vi.waitFor(() => expect(reads).toBe(3));
    await tick();

    expect(
      host.querySelector('[aria-label="Meeting notifications"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("rolls back only the failed native field while a peer setting write succeeds", async () => {
    const notificationsWrite = deferred<ReturnType<typeof failure>>();
    const shareWrite = deferred<ReturnType<typeof ok<void>>>();
    const getSettings = vi.fn(async () =>
      ok({ notifications: true, shareNotifications: true }),
    );
    const { adapter, updateSettings } = adapterForSettings({
      getSettings,
      updateSettings: (patch) =>
        "notifications" in patch ? notificationsWrite.promise : shareWrite.promise,
      canSync: true,
    });
    mountPane("notifications", adapter);
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalledTimes(1));

    const meetingNotifications = host.querySelector<HTMLButtonElement>(
      '[aria-label="Meeting notifications"]',
    );
    const shareNotifications = host.querySelector<HTMLButtonElement>(
      '[aria-label="Share notifications"]',
    );
    expect(meetingNotifications?.disabled).toBe(false);
    expect(shareNotifications?.disabled).toBe(false);
    meetingNotifications?.click();
    shareNotifications?.click();
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    shareWrite.resolve(ok(undefined));
    notificationsWrite.resolve(failure("save-settings", "disk full"));
    await Promise.all([shareWrite.promise, notificationsWrite.promise]);
    await tick();

    expect(
      host.querySelector('[aria-label="Meeting notifications"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      host.querySelector('[aria-label="Share notifications"]')?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("uses the host-owned notification settings remediation for denied permissions", async () => {
    const { adapter, openNotificationSettings, requestNotificationPermission } =
      adapterForSettings({
        getSettings: async () => ok({}),
        notificationPermissionState: async () => ok("denied"),
        canTray: true,
      });
    mountPane("notifications", adapter);

    await vi.waitFor(() => {
      expect(host.querySelector("button.chip")?.textContent).toBe("Open Settings");
    });
    host.querySelector<HTMLButtonElement>("button.chip")?.click();
    await vi.waitFor(() => expect(openNotificationSettings).toHaveBeenCalledTimes(1));
    expect(requestNotificationPermission).not.toHaveBeenCalled();
  });
});
