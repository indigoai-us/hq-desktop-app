/**
 * Pure labels and action flags for the shared desktop-app update row.
 *
 * The Core mini-menu and Settings › Updates both render from this so a
 * CHECKING / UPDATE AVAILABLE / DOWNLOADING 42% / RESTART TO UPDATE pill can
 * never disagree between the two surfaces.
 */
import type { UpdateRowStatus } from "./update-orchestration";

/**
 * Lifecycle of a queued desktop-app update, layered over the check status:
 *   idle        — nothing queued
 *   queued      — the native host announced an install (automatic updates)
 *                 but no bytes have landed yet
 *   downloading — bytes are landing (manual queue or automatic install)
 *   ready       — verified package staged; waiting for "Restart to update"
 *   installing  — install + restart handed to the native host
 *   failed      — download/install failed; the row offers the download again
 */
export type AppInstallPhase =
  | "idle"
  | "queued"
  | "downloading"
  | "ready"
  | "installing"
  | "failed";

export function appRowStatusLabel(input: {
  status: UpdateRowStatus;
  installPhase: AppInstallPhase;
  downloadPercent: number | null;
}): string {
  switch (input.installPhase) {
    case "downloading":
      return input.downloadPercent == null
        ? "DOWNLOADING"
        : `DOWNLOADING ${input.downloadPercent}%`;
    case "queued":
      return "QUEUED";
    case "ready":
      return "RESTART TO UPDATE";
    case "installing":
      return "INSTALLING";
    case "failed":
      return "UPDATE FAILED";
    default:
      break;
  }
  switch (input.status) {
    case "checking":
      return "CHECKING";
    case "available":
      return "UPDATE AVAILABLE";
    case "up-to-date":
      return "UP TO DATE";
    case "failed":
      return "CHECK FAILED";
    default:
      return "NOT CHECKED";
  }
}

export function isInstallBusyPhase(phase: AppInstallPhase): boolean {
  return phase === "downloading" || phase === "queued" || phase === "installing";
}

export function appRowActions(input: {
  status: UpdateRowStatus;
  installPhase: AppInstallPhase;
}): {
  showCheck: boolean;
  showDownload: boolean;
  showRestart: boolean;
} {
  const busy = isInstallBusyPhase(input.installPhase);
  return {
    showCheck: !busy && input.installPhase !== "ready",
    showDownload:
      input.status === "available" &&
      (input.installPhase === "idle" || input.installPhase === "failed"),
    showRestart: input.installPhase === "ready",
  };
}

export function isInstallAlreadyInProgress(message?: string | null): boolean {
  return (message ?? "").toLowerCase().includes("already in progress");
}

export function progressPercentFrom(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const rec = payload as { percent?: unknown; downloaded?: unknown; total?: unknown };
  if (typeof rec.percent === "number" && Number.isFinite(rec.percent)) {
    return Math.max(0, Math.min(100, Math.round(rec.percent)));
  }
  const downloaded = rec.downloaded;
  const total = rec.total;
  if (
    typeof downloaded === "number" &&
    typeof total === "number" &&
    Number.isFinite(downloaded) &&
    Number.isFinite(total) &&
    total > 0
  ) {
    return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
  }
  return null;
}

export function versionFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const version = (payload as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}
