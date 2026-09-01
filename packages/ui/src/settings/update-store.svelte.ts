/**
 * Shared desktop-app / Core / CLI update store.
 *
 * One checker (createUpdateCheckRunner + runUpdateCheck) feeds one snapshot
 * that Settings › Updates and the titlebar Core mini-menu both read. Do not
 * add a second check path — getPendingUpdate is hydration only, never the
 * source of "up to date".
 */
import {
  createUpdateCheckRunner,
  type AdapterResult,
  type UpdateCheckOutcome,
  type UpdateOrchestrationAdapter,
  type UpdateRowStatus,
} from "./update-orchestration";
import {
  isInstallAlreadyInProgress,
  isInstallBusyPhase,
  progressPercentFrom,
  versionFromPayload,
  type AppInstallPhase,
} from "./update-presentation";

export interface UpdateStoreAdapter extends UpdateOrchestrationAdapter {
  /** Phase 1 of the queued update — background download of the verified package. */
  downloadUpdate(): Promise<AdapterResult<unknown>>;
  /** Phase 2 — install the staged package and restart. */
  installDownloadedUpdate(): Promise<AdapterResult<unknown>>;
  /** Staged-but-not-installed package, if any. */
  getDownloadedUpdate(): Promise<AdapterResult<unknown>>;
}

const INITIAL = {
  appStatus: "unchecked" as UpdateRowStatus,
  coreStatus: "unchecked" as UpdateRowStatus,
  cliStatus: "unchecked" as UpdateRowStatus,
  coreVersion: null as string | null,
  cliVersion: null as string | null,
  coreProbeError: null as string | null,
  cliProbeError: null as string | null,
  availableVersion: null as string | null,
  coreState: null as unknown,
  checking: false,
  installPhase: "idle" as AppInstallPhase,
  downloadPercent: null as number | null,
  autoUpdateEnabled: true,
  installError: null as string | null,
};

let appStatus = $state<UpdateRowStatus>(INITIAL.appStatus);
let coreStatus = $state<UpdateRowStatus>(INITIAL.coreStatus);
let cliStatus = $state<UpdateRowStatus>(INITIAL.cliStatus);
let coreVersion = $state<string | null>(INITIAL.coreVersion);
let cliVersion = $state<string | null>(INITIAL.cliVersion);
let coreProbeError = $state<string | null>(INITIAL.coreProbeError);
let cliProbeError = $state<string | null>(INITIAL.cliProbeError);
let availableVersion = $state<string | null>(INITIAL.availableVersion);
let coreState = $state<unknown>(INITIAL.coreState);
let checking = $state(INITIAL.checking);
let installPhase = $state<AppInstallPhase>(INITIAL.installPhase);
let downloadPercent = $state<number | null>(INITIAL.downloadPercent);
let autoUpdateEnabled = $state(INITIAL.autoUpdateEnabled);
let installError = $state<string | null>(INITIAL.installError);

let runner = createUpdateCheckRunner();
let downloadInFlight: Promise<void> | null = null;
let installInFlight: Promise<void> | null = null;
let storeGeneration = 0;

function applyOutcome(outcome: UpdateCheckOutcome): void {
  appStatus =
    outcome.appStatus === "unlocated" ? "unchecked" : outcome.appStatus;
  coreStatus = outcome.coreStatus;
  cliStatus = outcome.cliStatus;
  coreVersion = outcome.coreVersion;
  cliVersion = outcome.cliVersion;
  coreProbeError = outcome.coreProbeError;
  cliProbeError = outcome.cliProbeError;
  availableVersion = outcome.appUpdateVersion;
  coreState = outcome.coreState;
}

const NOT_ON_THIS_HOST = async (): Promise<AdapterResult<never>> => ({
  ok: false as const,
  reason: "unavailable",
  message: "Update install is not available on this host.",
});

export function orchestrationAdapterFrom(updates: {
  getVersions: UpdateOrchestrationAdapter["getVersions"];
  checkForUpdates: UpdateOrchestrationAdapter["checkForUpdates"];
  checkCoreState: UpdateOrchestrationAdapter["checkCoreState"];
  checkCliUpdate: UpdateOrchestrationAdapter["checkCliUpdate"];
  downloadUpdate?: UpdateStoreAdapter["downloadUpdate"];
  installDownloadedUpdate?: UpdateStoreAdapter["installDownloadedUpdate"];
  getDownloadedUpdate?: UpdateStoreAdapter["getDownloadedUpdate"];
}): UpdateStoreAdapter {
  return {
    getVersions: () => updates.getVersions(),
    checkForUpdates: () => updates.checkForUpdates(),
    checkCoreState: () => updates.checkCoreState(),
    checkCliUpdate: () => updates.checkCliUpdate(),
    downloadUpdate: updates.downloadUpdate ?? NOT_ON_THIS_HOST,
    installDownloadedUpdate: updates.installDownloadedUpdate ?? NOT_ON_THIS_HOST,
    getDownloadedUpdate:
      updates.getDownloadedUpdate ?? (async () => ({ ok: true as const, value: null })),
  };
}

export async function checkDesktopUpdates(
  adapter: UpdateOrchestrationAdapter,
): Promise<UpdateCheckOutcome> {
  const generation = storeGeneration;
  if (runner.isRunning()) {
    const outcome = await runner.run(adapter);
    if (generation === storeGeneration) applyOutcome(outcome);
    return outcome;
  }
  checking = true;
  appStatus = "checking";
  coreStatus = "checking";
  cliStatus = "checking";
  coreProbeError = null;
  cliProbeError = null;
  try {
    const outcome = await runner.run(adapter, {
      onRow: (row, status) => {
        if (generation !== storeGeneration) return;
        if (row === "app") {
          appStatus = status === "unlocated" ? "unchecked" : status;
        } else if (row === "core") {
          coreStatus = status;
        } else {
          cliStatus = status;
        }
      },
      onVersions: (versions) => {
        if (generation !== storeGeneration) return;
        coreVersion = versions.coreVersion;
        cliVersion = versions.cliVersion;
        coreProbeError = versions.coreProbeError;
        cliProbeError = versions.cliProbeError;
      },
    });
    if (generation === storeGeneration) applyOutcome(outcome);
    return outcome;
  } finally {
    if (generation === storeGeneration) checking = false;
  }
}

/**
 * "Download & install": phase 1 of the queued update. Downloads the verified
 * package in the background (progress arrives via reportDownloadProgress),
 * then parks the row on RESTART TO UPDATE. A second call while a download or
 * install is already running (manual or automatic) is a no-op.
 */
export async function downloadDesktopUpdate(
  adapter: Pick<UpdateStoreAdapter, "downloadUpdate">,
): Promise<void> {
  if (isInstallBusyPhase(installPhase) || installPhase === "ready") return;
  if (downloadInFlight) return downloadInFlight;
  const generation = storeGeneration;
  installError = null;
  installPhase = "downloading";
  if (downloadPercent == null) downloadPercent = 0;
  const run = (async () => {
    const result = await adapter.downloadUpdate();
    if (generation !== storeGeneration) return;
    if (result.ok) {
      const version = versionFromPayload(result.value);
      if (version) availableVersion = version;
      installPhase = "ready";
      downloadPercent = 100;
      return;
    }
    if (isInstallAlreadyInProgress(result.message)) {
      // The automatic installer already owns this package — reflect it
      // instead of racing a second download.
      installPhase = "queued";
      return;
    }
    installPhase = "failed";
    installError = result.message ?? "Download failed";
  })().finally(() => {
    if (generation === storeGeneration) downloadInFlight = null;
  });
  downloadInFlight = run;
  return run;
}

/**
 * "Restart to update": phase 2. Hands the staged package to the native
 * installer, which restarts the app on success. On failure the staged bytes
 * stay on the host, so the row can retry without another download.
 */
export async function restartToUpdate(
  adapter: Pick<UpdateStoreAdapter, "installDownloadedUpdate">,
): Promise<void> {
  if (installPhase !== "ready") return;
  if (installInFlight) return installInFlight;
  const generation = storeGeneration;
  installError = null;
  installPhase = "installing";
  const run = (async () => {
    const result = await adapter.installDownloadedUpdate();
    if (generation !== storeGeneration) return;
    if (result.ok) return; // the host restarts; nothing further to paint
    if (isInstallAlreadyInProgress(result.message)) {
      installPhase = "queued";
      return;
    }
    installPhase = "ready";
    installError = result.message ?? "Install failed";
  })().finally(() => {
    if (generation === storeGeneration) installInFlight = null;
  });
  installInFlight = run;
  return run;
}

/**
 * Late-mounting surfaces (the popover opens after a download finished in the
 * background) hydrate straight into RESTART TO UPDATE from the host's staged
 * package. Never downgrades an in-flight phase.
 */
export async function hydrateDownloadedUpdate(
  adapter: Pick<UpdateStoreAdapter, "getDownloadedUpdate">,
): Promise<void> {
  const generation = storeGeneration;
  const result = await adapter.getDownloadedUpdate();
  if (generation !== storeGeneration || !result.ok) return;
  const version = versionFromPayload(result.value);
  if (!version) return;
  if (installPhase !== "idle" && installPhase !== "failed") return;
  availableVersion = version;
  if (appStatus !== "checking") appStatus = "available";
  installPhase = "ready";
  downloadPercent = 100;
}

export function reportDownloadProgress(payload: unknown): void {
  const percent = progressPercentFrom(payload);
  if (installPhase === "idle" || installPhase === "failed") {
    // Progress without a local download call means the automatic installer
    // (or another window) owns this package.
    installPhase = "downloading";
  }
  if (installPhase === "queued" && percent != null) {
    installPhase = "downloading";
  }
  if (installPhase === "downloading" && percent != null) {
    downloadPercent = percent;
  }
}

/** Host `update:downloaded` — the verified package is staged. */
export function markDownloaded(version?: string | null): void {
  if (version && version.trim()) availableVersion = version.trim();
  if (installPhase === "installing") return;
  installPhase = "ready";
  downloadPercent = 100;
}

/** Host `update:install-started` — automatic or manual install began. */
export function markInstallStarted(version?: string | null): void {
  if (version && version.trim()) availableVersion = version.trim();
  installError = null;
  if (installPhase === "ready" || installPhase === "installing") {
    installPhase = "installing";
    return;
  }
  if (installPhase === "downloading") return;
  installPhase = "queued";
}

/** Host `update:install-failed` — download or install failed natively. */
export function reportInstallFailed(payload: unknown): void {
  const rec =
    payload && typeof payload === "object"
      ? (payload as { message?: unknown })
      : null;
  installError =
    typeof rec?.message === "string" && rec.message.trim()
      ? rec.message.trim()
      : "Update failed";
  installPhase = "failed";
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  autoUpdateEnabled = enabled;
}

export function applyAvailableUpdate(version: string | null): void {
  if (version && version.trim()) {
    availableVersion = version.trim();
    if (appStatus !== "checking") appStatus = "available";
    return;
  }
  if (installPhase === "idle") {
    availableVersion = null;
    if (appStatus === "available") appStatus = "up-to-date";
  }
}

export function resetUpdateStore(): void {
  storeGeneration += 1;
  appStatus = INITIAL.appStatus;
  coreStatus = INITIAL.coreStatus;
  cliStatus = INITIAL.cliStatus;
  coreVersion = INITIAL.coreVersion;
  cliVersion = INITIAL.cliVersion;
  coreProbeError = INITIAL.coreProbeError;
  cliProbeError = INITIAL.cliProbeError;
  availableVersion = INITIAL.availableVersion;
  coreState = INITIAL.coreState;
  checking = INITIAL.checking;
  installPhase = INITIAL.installPhase;
  downloadPercent = INITIAL.downloadPercent;
  autoUpdateEnabled = INITIAL.autoUpdateEnabled;
  installError = INITIAL.installError;
  installInFlight = null;
  downloadInFlight = null;
  runner = createUpdateCheckRunner();
}

export const updateStore = {
  get appStatus() {
    return appStatus;
  },
  get coreStatus() {
    return coreStatus;
  },
  get cliStatus() {
    return cliStatus;
  },
  get coreVersion() {
    return coreVersion;
  },
  get cliVersion() {
    return cliVersion;
  },
  get coreProbeError() {
    return coreProbeError;
  },
  get cliProbeError() {
    return cliProbeError;
  },
  get availableVersion() {
    return availableVersion;
  },
  get coreState() {
    return coreState;
  },
  get checking() {
    return checking;
  },
  get installPhase() {
    return installPhase;
  },
  get downloadPercent() {
    return downloadPercent;
  },
  get autoUpdateEnabled() {
    return autoUpdateEnabled;
  },
  get installError() {
    return installError;
  },
  get isInstallBusy() {
    return isInstallBusyPhase(installPhase);
  },
};
