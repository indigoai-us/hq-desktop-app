/**
 * Deploy progress for personal and company deployment rows (US-031).
 * The build that is already live keeps serving until the swap step.
 * Steps are 1-based: pack, build, upload, swap, live.
 */

export const DEPLOY_STEP_COUNT = 5;

export const DEPLOY_STEP_LABELS = ["pack", "build", "upload", "swap", "live"] as const;

export interface DeployProgressInput {
  /** 1-based step currently running. */
  step?: number | null;
  /** Version already serving. */
  liveVersion?: string | null;
  /** Version being built. */
  nextVersion?: string | null;
}

export interface DeployProgress {
  step: number;
  /** 0–100, from the current step. */
  percent: number;
  /** Version visitors still receive. */
  serving: string;
  swapped: boolean;
  label: string;
}

export function deployProgress(input: DeployProgressInput = {}): DeployProgress {
  const raw = Number(input.step);
  const step = Number.isFinite(raw)
    ? Math.min(DEPLOY_STEP_COUNT, Math.max(1, Math.trunc(raw)))
    : 3;
  const live = (input.liveVersion ?? "").trim() || "current";
  const next = (input.nextVersion ?? "").trim() || "next";
  // Swap is step 4. Until then the previous build stays live.
  const swapped = step >= 4;
  return {
    step,
    percent: Math.round((step / DEPLOY_STEP_COUNT) * 100),
    serving: swapped ? next : live,
    swapped,
    label: `${swapped ? next : live} stays live until swap`,
  };
}
