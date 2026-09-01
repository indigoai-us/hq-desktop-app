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
  progressPercentFrom,
  type AppInstallPhase,
} from "./update-presentation";

export interface UpdateStoreAdapter extends UpdateOrchestrationAdapter {
  installUpdate(): Promise<AdapterResult<unknown>>;
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

export function orchestrationAdapterFrom(updates: {
  getVersions: UpdateOrchestrationAdapter["getVersions"];
  checkForUpdates: UpdateOrchestrationAdapter["checkForUpdates"];
  checkCoreState: UpdateOrchestrationAdapter["checkCoreState"];
  checkCliUpdate: UpdateOrchestrationAdapter["checkCliUpdate"];
  installUpdate?: UpdateStoreAdapter["installUpdate"];
}): UpdateStoreAdapter {
  return {
    getVersions: () => updates.getVersions(),
    checkForUpdates: () => updates.checkForUpdates(),
    checkCoreState: () => updates.checkCoreState(),
    checkCliUpdate: () => updates.checkCliUpdate(),
    installUpdate:
      updates.installUpdate ??
      (async () => ({
        ok: false as const,
        reason: "unavailable",
        message: "Install is not available on this host.",
      })),
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

export async function installDesktopUpdate(
  adapter: Pick<UpdateStoreAdapter, "installUpdate">,
): Promise<void> {
  if (installPhase === "downloading" || installPhase === "queued") return;
  if (installInFlight) return installInFlight;
  const generation = storeGeneration;
  installError = null;
  installPhase = "downloading";
  if (downloadPercent == null) downloadPercent = 0;
  const run = (async () => {
    const result = await adapter.installUpdate();
    if (generation !== storeGeneration) return;
    if (result.ok) {
      installPhase = "ready";
      downloadPercent = 100;
      return;
    }
    if (isInstallAlreadyInProgress(result.message)) {
      installPhase = "queued";
      return;
    }
    installPhase = "failed";
    installError = result.message ?? "Install failed";
  })().finally(() => {
    if (generation === storeGeneration) installInFlight = null;
  });
  installInFlight = run;
  return run;
}

export function reportDownloadProgress(payload: unknown): void {
  const percent = progressPercentFrom(payload);
  if (
    installPhase === "idle" &&
    (appStatus === "available" || autoUpdateEnabled)
  ) {
    installPhase = autoUpdateEnabled ? "queued" : "downloading";
  }
  if (installPhase === "queued" && percent != null) {
    installPhase = "downloading";
  }
  if (installPhase === "downloading" || installPhase === "queued") {
    if (percent != null) downloadPercent = percent;
  }
}

export function markInstallStarted(version?: string | null): void {
  if (version && version.trim()) availableVersion = version.trim();
  if (installPhase === "ready" || installPhase === "downloading") return;
  installPhase = "queued";
  installError = null;
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
    return installPhase === "downloading" || installPhase === "queued";
  },
};
