// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import CorePopover from "../home/CorePopover.svelte";
import {
  appRowActions,
  appRowIdleHint,
  appRowStatusLabel,
  isInstallAlreadyInProgress,
  progressPercentFrom,
  recommendBannerFromPayload,
} from "./update-presentation";
import {
  applyRecommendBanner,
  checkDesktopUpdates,
  dismissRecommendBanner,
  downloadDesktopUpdate,
  hydrateDownloadedUpdate,
  installRecommendedUpdate,
  markDownloaded,
  markInstallStarted,
  reportDownloadProgress,
  reportIdleWait,
  reportInstallFailed,
  resetUpdateStore,
  restartToUpdate,
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
    downloadUpdate:
      overrides.downloadUpdate ?? (async () => pass({ version: "0.10.173" })),
    installDownloadedUpdate:
      overrides.installDownloadedUpdate ?? (async () => pass(undefined)),
    getDownloadedUpdate: overrides.getDownloadedUpdate ?? (async () => pass(null)),
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
    ).toBe("RESTART TO UPDATE");
    expect(appRowIdleHint(480)).toBe(
      "Auto-install waits for a sync gap · 8 min left",
    );
    expect(appRowIdleHint(0)).toBe(
      "Auto-install is pausing sync, then restarting",
    );
    expect(
      recommendBannerFromPayload({
        latestVersion: "0.10.185",
        message: "Please update.",
      }),
    ).toEqual({ version: "0.10.185", message: "Please update." });
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "installing",
        downloadPercent: 100,
      }),
    ).toBe("INSTALLING");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: "failed",
        downloadPercent: null,
      }),
    ).toBe("UPDATE FAILED");
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
    expect(
      appRowActions({ status: "available", installPhase: "installing" }).showDownload,
    ).toBe(false);
    expect(
      appRowActions({ status: "available", installPhase: "failed" }).showDownload,
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

  it("Download & install calls orchestration, shows progress, then offers restart, then installs", async () => {
    const download = deferred<unknown>();
    const downloadUpdate = vi.fn(() => download.promise as Promise<never>);
    const installDownloadedUpdate = vi.fn(async () => pass(undefined));
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    const running = downloadDesktopUpdate(orch({ downloadUpdate }));
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
    // A second click mid-download shares the in-flight download.
    await Promise.race([downloadDesktopUpdate(orch({ downloadUpdate })), Promise.resolve()]);
    download.resolve(pass({ version: "0.10.173" }));
    await running;
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updateStore.installPhase).toBe("ready");
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("RESTART TO UPDATE");
    expect(appRowActions({ status: "available", installPhase: "ready" }).showRestart).toBe(
      true,
    );
    expect(installDownloadedUpdate).not.toHaveBeenCalled();

    await restartToUpdate(orch({ installDownloadedUpdate }));
    expect(installDownloadedUpdate).toHaveBeenCalledTimes(1);
    expect(updateStore.installPhase).toBe("installing");
  });

  it("a failed install keeps the staged package and returns to Restart to update", async () => {
    await checkDesktopUpdates(
      orch({ checkForUpdates: async () => pass({ version: "0.10.173" }) }),
    );
    await downloadDesktopUpdate(orch({}));
    await restartToUpdate(
      orch({ installDownloadedUpdate: async () => fail("disk full") }),
    );
    expect(updateStore.installPhase).toBe("ready");
    expect(updateStore.installError).toBe("disk full");
  });

  it("hydrates a package downloaded while the surface was closed into Restart to update", async () => {
    await hydrateDownloadedUpdate(
      orch({ getDownloadedUpdate: async () => pass({ version: "0.10.173" }) }),
    );
    expect(updateStore.installPhase).toBe("ready");
    expect(updateStore.appStatus).toBe("available");
    expect(updateStore.availableVersion).toBe("0.10.173");
    // No staged package → untouched.
    resetUpdateStore();
    await hydrateDownloadedUpdate(orch({}));
    expect(updateStore.installPhase).toBe("idle");
  });

  it("never keeps DOWNLOADING 0% once the host has staged the package", async () => {
    reportDownloadProgress({ percent: 0 });
    expect(updateStore.installPhase).toBe("downloading");
    expect(
      appRowStatusLabel({
        status: "available",
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("DOWNLOADING 0%");
    await hydrateDownloadedUpdate(
      orch({
        getDownloadedUpdate: async () =>
          pass({ version: "0.10.184", waitingForIdleSecs: 480 }),
      }),
    );
    expect(updateStore.installPhase).toBe("ready");
    expect(updateStore.downloadPercent).toBe(100);
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("RESTART TO UPDATE");
    expect(updateStore.idleWaitRemainingSecs).toBe(480);
    reportDownloadProgress({ percent: 0 });
    expect(updateStore.installPhase).toBe("ready");
  });

  it("waiting-for-idle events keep Restart to update with a countdown", () => {
    reportIdleWait({ version: "0.10.184", remainingSecs: 600 });
    expect(updateStore.installPhase).toBe("ready");
    expect(appRowIdleHint(updateStore.idleWaitRemainingSecs)).toContain(
      "sync gap",
    );
  });

  it("recommend banner is dismissible and Update now downloads then installs", async () => {
    const downloadUpdate = vi.fn(async () => pass({ version: "0.10.185" }));
    const installDownloadedUpdate = vi.fn(async () => pass(undefined));
    applyRecommendBanner({
      latestVersion: "0.10.185",
      message: "A newer HQ is recommended.",
    });
    expect(updateStore.recommendBanner).toEqual({
      version: "0.10.185",
      message: "A newer HQ is recommended.",
    });
    dismissRecommendBanner();
    expect(updateStore.recommendBanner).toBeNull();
    applyRecommendBanner({ latest_version: "0.10.185" });
    await installRecommendedUpdate(
      orch({ downloadUpdate, installDownloadedUpdate }),
    );
    expect(updateStore.recommendBanner).toBeNull();
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
    expect(installDownloadedUpdate).toHaveBeenCalledTimes(1);
    expect(updateStore.installPhase).toBe("installing");
  });

  it("host events move the row from downloading to staged to failed", () => {
    reportDownloadProgress({ downloaded: 5, total: 10 });
    expect(updateStore.installPhase).toBe("downloading");
    expect(updateStore.downloadPercent).toBe(50);
    markDownloaded("0.10.173");
    expect(updateStore.installPhase).toBe("ready");
    markInstallStarted("0.10.173");
    expect(updateStore.installPhase).toBe("installing");
    reportInstallFailed({ version: "0.10.173", message: "helper exited" });
    expect(updateStore.installPhase).toBe("failed");
    expect(updateStore.installError).toBe("helper exited");
  });

  it("already-queued auto-update suppresses a second download", async () => {
    const downloadUpdate = vi.fn(async () => pass({ version: "0.10.173" }));
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    setAutoUpdateEnabled(true);
    markInstallStarted("0.10.173");
    expect(updateStore.installPhase).toBe("queued");
    expect(
      appRowStatusLabel({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
        downloadPercent: updateStore.downloadPercent,
      }),
    ).toBe("QUEUED");
    expect(
      appRowActions({
        status: updateStore.appStatus,
        installPhase: updateStore.installPhase,
      }).showDownload,
    ).toBe(false);
    await downloadDesktopUpdate(orch({ downloadUpdate }));
    expect(downloadUpdate).not.toHaveBeenCalled();
    reportDownloadProgress({ percent: 42 });
    expect(updateStore.installPhase).toBe("downloading");
    expect(updateStore.downloadPercent).toBe(42);
  });

  it("an already-in-progress install error becomes queued instead of a second download", async () => {
    await checkDesktopUpdates(
      orch({
        checkForUpdates: async () => pass({ version: "0.10.173" }),
      }),
    );
    await downloadDesktopUpdate(
      orch({
        downloadUpdate: async () =>
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
      downloadUpdate: vi.fn(async () => ok({ version: "0.10.173" })),
      installDownloadedUpdate: vi.fn(async () => ok(undefined)),
      getDownloadedUpdate: vi.fn(async () => ok(null)),
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

  it("Download & install on the popover downloads, shows progress on both, then Restart to update installs", async () => {
    const install = deferred<unknown>();
    const adapter = updatesAdapter({
      downloadUpdate: vi.fn(() => install.promise),
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
    install.resolve(ok({ version: "0.10.173" }));
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("Restart to update");
      expect(popoverHost.textContent).toContain("RESTART TO UPDATE");
      expect(paneHost.textContent).toContain("RESTART TO UPDATE");
      expect(paneHost.querySelector('[data-testid="settings-app-restart"]')).toBeTruthy();
    });
    const updates = adapter.updates as unknown as {
      downloadUpdate: ReturnType<typeof vi.fn>;
      installDownloadedUpdate: ReturnType<typeof vi.fn>;
    };
    expect(updates.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(updates.installDownloadedUpdate).not.toHaveBeenCalled();

    popoverHost
      .querySelector<HTMLButtonElement>('[data-testid="core-popover-restart-update"]')!
      .click();
    await vi.waitFor(() => {
      flushSync();
      expect(updates.installDownloadedUpdate).toHaveBeenCalledTimes(1);
      expect(popoverHost.textContent).toContain("INSTALLING");
      expect(paneHost.textContent).toContain("INSTALLING");
    });
  });

  it("an automatic install already queued shows on both surfaces without a Download button", async () => {
    const adapter = updatesAdapter();
    const { paneHost, popoverHost } = mountBoth(adapter);
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.querySelector('[data-testid="core-popover-download-install"]')).toBeTruthy();
    });
    setAutoUpdateEnabled(true);
    markInstallStarted("0.10.173");
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("QUEUED");
      expect(paneHost.textContent).toContain("QUEUED");
    });
    expect(popoverHost.querySelector('[data-testid="core-popover-download-install"]')).toBeNull();
    expect(paneHost.querySelector('[data-testid="settings-app-download"]')).toBeNull();
    reportDownloadProgress({ percent: 42 });
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("DOWNLOADING 42%");
      expect(paneHost.textContent).toContain("DOWNLOADING 42%");
    });
  });

  it("a package downloaded while the popover was closed hydrates as RESTART TO UPDATE", async () => {
    const adapter = updatesAdapter({
      getDownloadedUpdate: vi.fn(async () => ok({ version: "0.10.173" })),
    });
    const { popoverHost } = mountBoth(adapter);
    await vi.waitFor(() => {
      flushSync();
      expect(popoverHost.textContent).toContain("RESTART TO UPDATE");
      expect(popoverHost.querySelector('[data-testid="core-popover-restart-update"]')).toBeTruthy();
    });
  });

  it("shows the idle-wait hint on both surfaces while auto-install waits", async () => {
    const adapter = updatesAdapter({
      getDownloadedUpdate: vi.fn(async () =>
        ok({ version: "0.10.184", waitingForIdleSecs: 420 }),
      ),
    });
    const { paneHost, popoverHost } = mountBoth(adapter);
    await vi.waitFor(() => {
      flushSync();
      expect(paneHost.textContent).toContain("RESTART TO UPDATE");
      expect(paneHost.textContent).toContain("sync gap");
      expect(popoverHost.textContent).toContain("RESTART TO UPDATE");
      expect(popoverHost.textContent).toContain("sync gap");
      expect(paneHost.querySelector('[data-testid="settings-app-restart"]')).toBeTruthy();
    });
  });
});
