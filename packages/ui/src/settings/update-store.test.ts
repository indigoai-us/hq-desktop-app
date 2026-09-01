// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import CorePopover from "../home/CorePopover.svelte";
import {
  appRowActions,
  appRowStatusLabel,
  isInstallAlreadyInProgress,
  progressPercentFrom,
} from "./update-presentation";
import {
  checkDesktopUpdates,
  installDesktopUpdate,
  markInstallStarted,
  reportDownloadProgress,
  resetUpdateStore,
  setAutoUpdateEnabled,
  updateStore,
} from "./update-store.svelte";

afterEach(() => {
  resetUpdateStore();
  vi.clearAllMocks();
});

const pass = <T,>(value: T) => ({ ok: true as const, value });
const fail = (message: string) => ({
  ok: false as const,
  reason: "invoke" as const,
  message,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function orch(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  return {
    getVersions:
      overrides.getVersions ?? (async () => pass({ core: "15.0.118", cli: "1.2.3" })),
    checkForUpdates: overrides.checkForUpdates ?? (async () => pass(null)),
    checkCoreState:
      overrides.checkCoreState ?? (async () => pass({ versionBehind: false })),
    checkCliUpdate: overrides.checkCliUpdate ?? (async () => pass(null)),
    installUpdate: overrides.installUpdate ?? (async () => pass(undefined)),
  } as never;
}

describe("update presentation labels", () => {
  it("keeps pane and popover status copy identical", () => {
    expect(
      appRowStatusLabel({
        status: "up-to-date",
        installPhase: "idle",
        downloadPercent: null,
      }),
    ).toBe("UP TO DATE");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "idle",
        downloadPercent: null,
      }),
    ).toBe("UPDATE AVAILABLE");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "downloading",
        downloadPercent: 42,
      }),
    ).toBe("DOWNLOADING 42%");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "queued",
        downloadPercent: null,
      }),
    ).toBe("QUEUED");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "ready",
        downloadPercent: 100,
      }),
    ).toBe("READY");
  });

  it("hides Download & install while a queued auto-update is installing", () => {
    expect(
      appRowActions({ status: "available", installPhase: "idle" }).showDownload,
    ).toBe(true);
    expect(
      appRowActions({ status: "available", installPhase: "queued" }).showDownload,
    ).toBe(false);
    expect(
      appRowActions({ status: "available", installPhase: "downloading" })
        .showDownload,
    ).toBe(false);
    expect(
      appRowActions({ status: "available", installPhase: "ready" }).showRestart,
    ).toBe(true);
  });

  it("reads native progress payloads and already-in-progress errors", () => {
    expect(progressPercentFrom({ percent: 42 })).toBe(42);
    expect(progressPercentFrom({ downloaded: 21, total: 50 })).toBe(42);
    expect(isInstallAlreadyInProgress("An update installation is already in progress")).toBe(
      true,
    );
  });
});

describe("shared update store", () => {
  it("Check sets in-flight then result", async () => {
    const versions = deferred<unknown>();
    const run = checkDesktopUpdates(
      orch({
        getVersions: () => versions.promise as Promise<never>,
      }),
    );
    expect(updateStore.checking).toBe(true);
    expect(updateStore.appStatus).toBe("checking");
    expect(updateStore.coreStatus).toBe("checking");
    versions.resolve(pass({ core: "15.0.118", cli: "1.2.3" }));
    await run;
    expect(updateStore.checking).toBe(false);
    expect(updateStore.appStatus).toBe("up-to-date");
    expect(updateStore.coreStatus).toBe("up-to-date");
    expect(updateStore.coreVersion).toBe("15.0.118");
  });

  it("offers a newer stable to a beta-channel install", async () => {
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    expect(updateStore.appStatus).toBe("available");
    expect(updateStore.availableVersion).toBe("0.10.173");
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("UPDATE AVAILABLE");
  });

  it("Download & install calls orchestration, shows progress, then restart", async () => {
    const install = deferred<unknown>();
    const installUpdate = vi.fn(() => install.promise as Promise<never>);
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    const running = installDesktopUpdate(orch({ installUpdate }));
    expect(updateStore.installPhase).toBe("downloading");
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("DOWNLOADING 0%");
    reportDownloadProgress({ percent: 42 });
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("DOWNLOADING 42%");
    install.resolve(pass(undefined));
    await running;
    expect(installUpdate).toHaveBeenCalledTimes(1);
    expect(updateStore.installPhase).toBe("ready");
    expect(appRowActions({ status: "available", installPhase: "ready" }).showRestart).toBe(
      true,
    );
  });

  it("already-queued auto-update suppresses a second download", async () => {
    const installUpdate = vi.fn(async () => pass(undefined));
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    setAutoUpdateEnabled(true);
    markInstallStarted("0.10.173");
    expect(updateStore.installPhase).toBe("queued");
    expect(
      appRowActions({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
      }).showDownload,
    ).toBe(false);
    await installDesktopUpdate(orch({ installUpdate }));
    expect(installUpdate).not.toHaveBeenCalled();
  });

  it("an already-in-progress install error becomes queued instead of a second download", async () => {
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    await installDesktopUpdate(
      orch({
        installUpdate: async () =>
          fail("An update installation is already in progress"),
      }),
    );
    expect(updateStore.installPhase).toBe("queued");
  });
});

function updatesAdapter(overrides: Record<string, unknown> = {}) {
  return {
    kind: "desktop",
    isAvailable: (capability: string) =>
      capability === "canSelfUpdate" || capability === "canManagePackages",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
    },
    meetings: { listAccounts: vi.fn(async () => ok([])) },
    settings: {
      getSettings: vi.fn(async () => ok({ autoUpdate: true, releaseChannel: "beta" })),
      updateSettings: vi.fn(async () => ok(undefined)),
    },
    packages: {
      listPackagesCached: async () => ok(null),
      listPackages: async () => ok({ packs: { installed: [] } }),
    },
    updates: {
      getVersions: vi.fn(async () => ok({ core: "15.0.118", cli: "1.2.3" })),
      checkForUpdates: vi.fn(async () => ok({ version: "0.10.173" })),
      checkCoreState: vi.fn(async () => ok({ versionBehind: false })),
      checkCliUpdate: vi.fn(async () => ok(null)),
      installUpdate: vi.fn(async () => ok(undefined)),
      availableChannels: vi.fn(async () => ok(["stable", "beta", "alpha"])),
      ...overrides,
    },
  } as unknown as PlatformAdapter;
}

describe("shared store keeps pane and popover in lockstep", () => {
  let hosts: HTMLDivElement[] = [];
  let components: Array<ReturnType<typeof mount>> = [];

  afterEach(async () => {
    for (const component of components) await unmount(component);
    components = [];
    for (const host of hosts) host.remove();
    hosts = [];
  });

  function mountBoth(adapter: PlatformAdapter) {
    const paneHost = document.createElement("div");
    const popoverHost = document.createElement("div");
    document.body.append(paneHost, popoverHost);
    hosts.push(paneHost, popoverHost);
    components.push(
      mount(PrototypeSettingsPanes, {
        target: paneHost,
        props: { section: "updates", adapter, version: "0.10.173-beta.11" },
      }),
      mount(CorePopover, {
        target: popoverHost,
        props: { adapter, appVersion: "0.10.173-beta.11", onclose: vi.fn() },
      }),
    );
    flushSync();
    return { paneHost, popoverHost };
  }

  it("shows UPDATE AVAILABLE on both surfaces for a beta user offered newer stable", async () => {
    const adapter = updatesAdapter();
    const { paneHost, popoverHost } = mountBoth(adapter);

    await vi.waitFor(() => {
      flushSync();
      expect(paneHost.textContent).toContain("UPDATE AVAILABLE");
      expect(popoverHost.textContent).toContain("UPDATE AVAILABLE");
      expect(popoverHost.textContent).toContain("Download & install");
    });
    expect(popoverHost.textContent).not.toContain("UP TO DATE");
    const updates = adapter.updates as unknown as {
      checkForUpdates: ReturnType<typeof vi.fn>;
    };
    expect(updates.checkForUpdates.mock.calls.length).toBeGreaterThan(0);
  });

  it("Check from the popover drives in-flight then result on the pane", async () => {
    const versions = deferred<unknown>();
    const adapter = updatesAdapter({
      getVersions: vi.fn(() => versions.promise),
      checkForUpdates: vi.fn(async () => ok(null)),
    });
    const { paneHost, popoverHost } = mountBoth(adapter);

    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("CHECKING");
      expect(paneHost.textContent).toContain("CHECKING");
    });

    versions.resolve(ok({ core: "15.0.118", cli: "1.2.3" }));
    await vi.waitFor(() => {
      flushSync();
      expect(paneHost.textContent).toContain("UP TO DATE");
      expect(popoverHost.textContent).toContain("UP TO DATE");
    });

    const check = popoverHost.querySelector<HTMLButtonElement>(
      '[data-testid="core-popover-check-updates"]',
    );
    expect(check).toBeTruthy();
    const before = (adapter.updates as unknown as { checkForUpdates: ReturnType<typeof vi.fn> })
      .checkForUpdates.mock.calls.length;
    check!.click();
    await vi.waitFor(() => {
      expect(
        (adapter.updates as unknown as { checkForUpdates: ReturnType<typeof vi.fn> })
          .checkForUpdates.mock.calls.length,
      ).toBeGreaterThan(before);
    });
  });

  it("Download & install on the popover calls the shared installer and shows progress", async () => {
    const install = deferred<unknown>();
    const adapter = updatesAdapter({
      installUpdate: vi.fn(() => install.promise),
    });
    const { paneHost, popoverHost } = mountBoth(adapter);
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.querySelector('[data-testid="core-popover-download-install"]')).toBeTruthy();
    });
    popoverHost
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-download-install"]')!
      .click();
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("DOWNLOADING");
      expect(paneHost.textContent).toContain("DOWNLOADING");
    });
    reportDownloadProgress({ percent: 42 });
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("DOWNLOADING 42%");
    });
    install.resolve(ok(undefined));
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("Restart to update");
      expect(popoverHost.textContent).toContain("READY");
    });
    expect(
      (adapter.updates as unknown as { installUpdate: ReturnType<typeof vi.fn> }).installUpdate,
    ).toHaveBeenCalledTimes(1);
  });
});
