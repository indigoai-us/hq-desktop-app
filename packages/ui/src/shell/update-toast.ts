import { isRecordingRestartDeferral } from "../settings/update-presentation";

/**
 * Plain copy for the app-update toast (OWNER-003 / OWNER-004).
 *
 * Every updater state and hold reason maps to a sentence. Raw state keys
 * (e.g. a camelCase hold code or an error `reason`) are never shown: an
 * unknown key falls back to generic copy.
 */

export type UpdateToastPhase =
  | "checking"
  | "downloading"
  | "ready"
  | "held"
  | "installing"
  | "deferred"
  | "failed";

export interface UpdateToastInput {
  version: string;
  reasons: string[];
  installing: boolean;
  installError: string | null;
  downloadPercent?: number | null;
  /** Lifecycle from the shared update store (download / install progress). */
  phase?: "checking" | "downloading" | "queued" | "installing" | "ready" | "failed" | "idle" | "deferred";
}

export interface UpdateToastCopy {
  phase: UpdateToastPhase;
  title: string;
  detail: string;
  error: string | null;
  installLabel: string;
  installDisabled: boolean;
  installTitle: string | null;
  /** 0..1 while bytes are counted, "indeterminate" while only busy, else null. */
  progress: number | "indeterminate" | null;
}

const FINISHING = "Finishing download";

/**
 * What the Restart button says while a recording, a transcript or an HQ
 * folder update holds the restart: it is disabled and says when it will work.
 * The toast and Settings > Updates share this sentence.
 */
export function heldRestartTitle(hold: string): string {
  return `${hold}. Restart becomes available when it finishes.`;
}

const HOLD_TEXT: Record<string, string> = {
  meetingrecording: "Waiting for your recording to finish",
  transcriptfinishing: "Waiting for a transcript to finish",
  uploadinflight: "Waiting for an upload to finish",
  coreupdateinprogress: "Waiting for the HQ folder update to finish",
};


/** True for text that looks like an internal key rather than a sentence. */
export function looksLikeStateKey(text: string): boolean {
  const value = text.trim();
  if (!value || /\s/.test(value)) return false;
  return /[a-z][A-Z]/.test(value) || /[_:]/.test(value);
}

/**
 * The holds that stop a restart the person asked for. A recording, a
 * transcript still saving and an HQ folder update do. An upload does not: sync
 * is nearly always running, so it only delays the automatic install (the
 * native gate's `blocks_restart`).
 */
export function restartHoldText(reasons: string[]): string | null {
  return holdReasonText(
    reasons.filter((reason) => reason.replace(/[_\s-]/g, "").toLowerCase() !== "uploadinflight"),
  );
}

export function holdReasonText(reasons: string[]): string | null {
  if (reasons.length === 0) return null;
  for (const reason of reasons) {
    const text = HOLD_TEXT[reason.replace(/[_\s-]/g, "").toLowerCase()];
    if (text) return text;
  }
  return "Waiting for HQ to finish a task";
}

function plainError(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const mapped = HOLD_TEXT[text.replace(/[_\s-]/g, "").toLowerCase()];
  if (mapped) return mapped;
  // Unknown text is raw transport/server output: never show it verbatim.
  return "Could not restart to update. Try again.";
}

export function updateToastCopy(input: UpdateToastInput): UpdateToastCopy {
  const version = input.version.trim();
  const ready = version ? `HQ ${version} is ready to install` : "An update is ready to install";
  // The host's deferral sentence names what holds the restart (a recording,
  // a transcript still saving, or an HQ Core update), so it is shown as-is.
  if (input.installError && isRecordingRestartDeferral(input.installError)) {
    return {
      phase: "deferred",
      title: "Update scheduled",
      detail: input.installError.trim(),
      error: null,
      installLabel: "Waiting to restart",
      installDisabled: true,
      installTitle: null,
      progress: null,
    };
  }
  if (input.installing || input.phase === "installing") {
    return { phase: "installing", title: "Updating HQ", detail: "Installing the update and restarting", error: null, installLabel: "Restarting…", installDisabled: true, installTitle: null, progress: "indeterminate" };
  }
  if (input.phase === "checking") {
    return { phase: "checking", title: "Checking for updates", detail: "Looking for a new version of HQ", error: null, installLabel: "Restart to update", installDisabled: true, installTitle: null, progress: "indeterminate" };
  }
  if (input.phase === "downloading" || input.phase === "queued") {
    const pct = input.downloadPercent;
    const known = input.phase === "downloading" && pct != null && Number.isFinite(pct);
    return {
      phase: "downloading",
      title: "Downloading update",
      detail: known ? `Downloading ${version ? `HQ ${version}` : "the new version"} (${Math.round(pct)}%)` : `Downloading ${version ? `HQ ${version}` : "the new version"}`,
      error: null,
      installLabel: "Restart to update",
      installDisabled: true,
      installTitle: FINISHING,
      progress: known ? Math.min(1, Math.max(0, pct / 100)) : "indeterminate",
    };
  }
  const error = plainError(input.installError);
  if (error) {
    return { phase: "failed", title: "Update failed", detail: ready, error, installLabel: "Try again", installDisabled: false, installTitle: null, progress: null };
  }
  const hold = holdReasonText(input.reasons);
  if (hold) {
    // The automatic install waits for every hold. Restart, which the person
    // asks for, waits only for the ones that would lose their work.
    const blocking = restartHoldText(input.reasons);
    return { phase: "held", title: "Update available", detail: hold, error: null, installLabel: "Restart to update", installDisabled: blocking !== null, installTitle: blocking ? heldRestartTitle(blocking) : null, progress: null };
  }
  return { phase: "ready", title: "Update available", detail: ready, error: null, installLabel: "Restart to update", installDisabled: false, installTitle: null, progress: null };
}
