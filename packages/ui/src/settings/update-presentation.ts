/**
 * Pure labels and action flags for the shared desktop-app update row.
 *
 * The Core mini-menu and Settings › Updates both render from this so a
 * CHECKING / UPDATE AVAILABLE / DOWNLOADING 42% pill can never disagree.
 */
import type { UpdateRowStatus } from "./update-orchestration";

export type AppInstallPhase =
  | "idle"
  | "downloading"
  | "queued"
  | "ready"
  | "failed";

export function appRowStatusLabel(input: {
  status: UpdateRowStatus;
  installPhase: AppInstallPhase;
  downloadPercent: number | null;
}): string {
  if (input.installPhase === "downloading") {
    return input.downloadPercent == null
      ? "DOWNLOADING"
      : `DOWNLOADING ${input.downloadPercent}%`;
  }
  if (input.installPhase === "queued") return "QUEUED";
  if (input.installPhase === "ready") return "READY";
  if (input.installPhase === "failed") return "INSTALL FAILED";
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

export function appRowActions(input: {
  status: UpdateRowStatus;
  installPhase: AppInstallPhase;
}): {
  showCheck: boolean;
  showDownload: boolean;
  showRestart: boolean;
} {
  const busy =
    input.installPhase === "downloading" || input.installPhase === "queued";
  return {
    showCheck: !busy,
    showDownload: input.status === "available" && input.installPhase === "idle",
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
