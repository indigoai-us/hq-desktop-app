/**
 * Settings › Updates per-row actions.
 *
 * Every row that can say UPDATE AVAILABLE also has an in-row button.
 * Failures stay quiet (retries, then Try again + open-in-AI), never raw
 * native/transport text and never a terminal command on the page.
 */
export const UPDATE_HEAL_PROMPT =
  "HQ couldn't update itself. Find out why and get it up to date.";

export const UPDATE_NOW_LABEL = "Update now";
export const RESTART_HQ_LABEL = "Restart HQ";
export const UPDATING_LABEL = "Updating…";
export const TRY_AGAIN_LABEL = "Try again";
export const UPDATE_FAILED_QUIET = "Couldn't update by itself.";

export const HEAL_TOOLS = [
  { key: "claude" as const, label: "Fix in Claude Code" },
  { key: "codex" as const, label: "Fix in Codex" },
  { key: "grok" as const, label: "Fix in Grok Build" },
];

export type HealToolKey = (typeof HEAL_TOOLS)[number]["key"];

export type RowInstallPhase = "idle" | "updating" | "failed";

export type QuietResult =
  | { ok: true }
  | { ok: false; reason?: string; message?: string };

export const QUIET_INSTALL_ATTEMPTS = 3;

/**
 * Run an install up to three times. Callers never surface the attempt
 * error — it is logged only. True means one attempt succeeded.
 */
export async function quietInstall(
  run: () => Promise<QuietResult>,
  attempts = QUIET_INSTALL_ATTEMPTS,
): Promise<boolean> {
  const n = Math.max(1, attempts);
  for (let i = 0; i < n; i += 1) {
    try {
      const result = await run();
      if (result.ok) return true;
      console.warn("[updates] install attempt failed", result.message ?? result.reason);
    } catch (err) {
      console.warn("[updates] install attempt threw", err);
    }
  }
  return false;
}

export function desktopButtonLabel(input: {
  busy: boolean;
  showDownload: boolean;
  showRestart: boolean;
  failed: boolean;
}): string | null {
  if (input.busy) return UPDATING_LABEL;
  if (input.showRestart) return RESTART_HQ_LABEL;
  if (input.failed) return TRY_AGAIN_LABEL;
  if (input.showDownload) return UPDATE_NOW_LABEL;
  return null;
}

export function rowButtonLabel(phase: RowInstallPhase, available: boolean): string | null {
  if (phase === "updating") return UPDATING_LABEL;
  if (phase === "failed") return TRY_AGAIN_LABEL;
  if (available) return UPDATE_NOW_LABEL;
  return null;
}
