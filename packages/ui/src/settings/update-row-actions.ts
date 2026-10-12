/**
 * Settings › Updates per-row actions.
 *
 * Every row that can say UPDATE AVAILABLE also has an in-row button.
 * Failures stay quiet (retries, then Try again + open-in-AI), never raw
 * native/transport text and never a terminal command on the page.
 */
export const UPDATE_HEAL_PROMPT =
  "HQ couldn't update itself. Find out why and get it up to date.";

/** The three Settings › Updates rows that can fail and offer a heal. */
export type UpdateRowKey = "app" | "core" | "cli";

export interface HealPromptFacts {
  /** Installed version, with or without a leading `v`. */
  current?: string | null;
  /** Version the update was going to install. */
  latest?: string | null;
  /** Last failure text from HQ's own install attempt. */
  reason?: string | null;
}

/** Longest failure reason quoted into a heal prompt. */
export const HEAL_REASON_MAX_CHARS = 400;

function versionText(version: string | null | undefined): string | null {
  const trimmed = version?.trim().replace(/^v(?=\d)/i, "");
  if (!trimmed) return null;
  // Semver-looking values read as `v1.2.3`; anything else (a staging commit
  // SHA) stays as it is.
  return /^\d+\.\d+/.test(trimmed) ? `v${trimmed}` : trimmed;
}

/**
 * One line of failure text for a prompt: whitespace and control characters
 * collapse to single spaces, trailing periods go (the prompt adds its own),
 * and long npm/stderr dumps are cut at `HEAL_REASON_MAX_CHARS`.
 */
export function healReasonText(reason: string | null | undefined): string | null {
  const flat = (reason ?? "")
    // ANSI colour/cursor sequences from npm or git output.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim();
  const cut =
    flat.length > HEAL_REASON_MAX_CHARS
      ? `${flat.slice(0, HEAL_REASON_MAX_CHARS - 1).trimEnd()}…`
      : flat;
  const clean = cut.replace(/[.\s]+$/, "");
  return clean ? clean : null;
}

function fromTo(facts: HealPromptFacts): string {
  const current = versionText(facts.current);
  const latest = versionText(facts.latest);
  return `from ${current ?? "the installed version"} to ${latest ?? "the latest version"}`;
}

function failedSentence(who: string, facts: HealPromptFacts): string {
  const reason = healReasonText(facts.reason);
  return reason ? `${who} failed: ${reason}.` : `${who} failed.`;
}

/**
 * The request a heal button hands to Claude Code, Codex or Grok Build for the
 * row whose own update failed. Each names exactly what to update, the
 * versions involved, the failure HQ saw, the commands to run, and how to
 * confirm it worked, so the agent can finish the update by itself.
 */
export function buildHealPrompt(row: UpdateRowKey, facts: HealPromptFacts = {}): string {
  const latest = versionText(facts.latest);
  if (row === "cli") {
    return [
      `Update the HQ CLI (@indigoai-us/hq-cli, the \`hq\` command) ${fromTo(facts)}.`,
      failedSentence("HQ's own update", facts),
      "Check `which -a hq` and `npm prefix -g`, run `npm install -g @indigoai-us/hq-cli@latest`",
      "(fix EACCES or Node version if it fails), then confirm with `hq --version`.",
    ].join(" ");
  }
  if (row === "core") {
    return [
      `Update HQ Core (the HQ files in this folder, versioned by hqVersion in core/core.yaml) ${fromTo(facts)}.`,
      failedSentence("HQ's own update", facts),
      "Run the /update-hq skill to upgrade from the latest indigoai-us/hq-core release",
      "(if it is not available, read .claude/skills/update-hq/SKILL.md and follow it),",
      "keep everything in personal/ and companies/,",
      `then confirm hqVersion in core/core.yaml reads ${latest ?? "the new version"}.`,
    ].join(" ");
  }
  return [
    `Update the HQ desktop app ${fromTo(facts)}.`,
    failedSentence("Its built-in updater", facts),
    "Download the newest release for this computer from",
    "https://github.com/indigoai-us/hq-desktop-app/releases/latest",
    "(the .dmg on macOS, the installer on Windows), quit HQ, install it over the existing app,",
    `then reopen HQ and confirm Settings › Updates shows ${latest ?? "the new version"}.`,
  ].join(" ");
}

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
  return (await quietInstallWithReason(run, attempts)).ok;
}

export type QuietInstallOutcome = { ok: true } | { ok: false; reason: string | null };

/**
 * `quietInstall`, also keeping the last attempt's failure text. The page still
 * never shows it; it only goes into the heal prompt so the agent starts from
 * the error HQ saw.
 */
export async function quietInstallWithReason(
  run: () => Promise<QuietResult>,
  attempts = QUIET_INSTALL_ATTEMPTS,
): Promise<QuietInstallOutcome> {
  const n = Math.max(1, attempts);
  let reason: string | null = null;
  for (let i = 0; i < n; i += 1) {
    try {
      const result = await run();
      if (result.ok) return { ok: true };
      console.warn("[updates] install attempt failed", result.message ?? result.reason);
      reason = result.message ?? result.reason ?? null;
    } catch (err) {
      console.warn("[updates] install attempt threw", err);
      reason = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, reason };
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
