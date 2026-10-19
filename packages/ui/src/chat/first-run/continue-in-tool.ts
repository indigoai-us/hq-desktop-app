/**
 * "Continue in <tool>" on the first-run decision screen (US-008).
 *
 * HQ Anywhere is installed only after the person presses Enable on the
 * callout. That press is the explicit opt-in, so the person setting is
 * written first. The startup reconcile reads the same setting, so an install
 * made here is kept on the next launch instead of being uninstalled. Then
 * the one tool's global runtime is installed. The kill switch read, the
 * opt-in write and the install share one deadline, so none of them can hold
 * the takeover. A wait that runs out is pending, not failed: the step keeps
 * running and reports its real result later. Not now, or
 * no callout, installs nothing. The tool stays closed: the welcome edition,
 * and later the Daily Brief, open it when the person presses Open.
 */

import {
  hqAnywhereRuntimeEnabled,
  putHqAnywherePersonSetting,
  type AdapterResult,
  type IdentityApi,
  type SettingsApi,
  type ShellApi,
} from "@hq/platform";
import { createLaunchActions, type LaunchShell } from "../../settings/launch-actions";
import type { FirstRunRuntime } from "./visual-first-run";

/** How long the install may run before the welcome report opens anyway. The tool stays closed. */
export const FIRST_RUN_INSTALL_WAIT_MS = 20_000;

/** Shown over the welcome report when the opt-in was not saved, so nothing was installed. */
export function optInNotSavedMessage(runtime: FirstRunRuntime): string {
  const tool = runtime === "codex" ? "Codex" : runtime === "grok" ? "Grok" : "Claude Code";
  return `Couldn't save your HQ Anywhere choice. HQ was not installed in ${tool}. Try again from Settings.`;
}

/** What Continue did about HQ Anywhere. `pending` is still running after the wait. */
export type ContinueInstallState = "installed" | "pending" | "failed" | "skipped";

export type ContinueInToolOutcome =
  /** The tool was not opened. `install` is skipped unless Enable was pressed. */
  | { kind: "prepared"; install: ContinueInstallState }
  /** The opt-in write failed, so nothing was installed. The tool was not opened. */
  | { kind: "prepared-without-opt-in"; message: string }
  /** No HQ folder to open the tool in later; the caller takes the chat path. */
  | { kind: "no-folder" };

export type OpenPreparedToolOutcome =
  | { kind: "opened" }
  | { kind: "no-folder" }
  /** The tool did not open; `message` is a plain sentence for the person. */
  | { kind: "open-failed"; message: string };

export interface ContinueInToolInput {
  runtime: FirstRunRuntime;
  settings: Pick<SettingsApi, "getSetupStatus" | "installRuntimeForTool" | "putHqAnywherePersonSetting">;
  /** Resolves the hq-anywhere-runtime kill switch. Missing or unreadable means on. */
  identity?: Pick<IdentityApi, "resolveFeatureFlagStatus">;
  log?: (message: string) => void;
  /** Test seam. */
  installWaitMs?: number;
  /** Test seam: the opt-in write's retry pause. */
  pause?: (milliseconds: number) => Promise<void>;
  /**
   * True only after Enable on the callout. Absent or false installs nothing,
   * even when the kill switch is on and an installer exists.
   */
  enableHqAnywhere?: boolean;
  /** A timed-out install settled. Not called when the wait already saw the result. */
  onInstallSettled?: (result: AdapterResult<void> | undefined) => void;
}

/**
 * True only when Continue will write the opt-in and install HQ into the tool.
 * Grok is never installed. A missing installer or an explicit kill switch
 * installs nothing. A missing or unreadable flag does not.
 */
export function continueWillInstallHq(input: {
  runtime: FirstRunRuntime;
  runtimeEnabled: boolean;
  canInstall: boolean;
}): boolean {
  return input.runtime !== "grok" && input.canInstall && input.runtimeEnabled;
}

async function hqFolder(settings: ContinueInToolInput["settings"]): Promise<string> {
  try {
    const status = await settings.getSetupStatus();
    if (!status.ok) return "";
    return (status.value as { hqFolderPath?: string } | null)?.hqFolderPath?.trim() ?? "";
  } catch (error) {
    console.warn("[first-run] setup status read failed", error);
    return "";
  }
}

/** What the Enable step did, once it finished. */
type EnableStepResult =
  | { kind: "not-installing" }
  | { kind: "opt-in-failed"; message: string }
  | { kind: "installed"; result: AdapterResult<void> | undefined };

/**
 * Resolves with the step's result, or "timeout" once the wait runs out.
 * The step itself is not cancelled: `settled` is that same promise.
 */
function bounded<T>(
  step: () => Promise<T>,
  waitMs: number,
): { raced: Promise<T | "timeout">; settled: Promise<T> } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  const settled = step();
  const raced = Promise.race([settled, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return { raced, settled };
}

export async function continueInTool(input: ContinueInToolInput): Promise<ContinueInToolOutcome> {
  const { runtime, settings } = input;
  const log = input.log ?? (() => undefined);
  const startedAt = Date.now();
  log(`continue-in-tool start runtime=${runtime}`);

  const folder = await hqFolder(settings);
  if (!folder) {
    console.warn("[first-run] no HQ folder to open the coding tool in");
    return { kind: "no-folder" };
  }

  let notice: string | null = null;
  let installState: ContinueInstallState = "skipped";
  // Enable is the consent. Not now, or a callout that was never shown, skips
  // the opt-in and the install.
  if (input.enableHqAnywhere === true) {
    // The kill switch read, the opt-in write and the install share one
    // deadline, so a hung flag read or setting write cannot hold Continue on
    // "Turning on HQ Anywhere…" any longer than a hung install can.
    const enableStep = async (): Promise<EnableStepResult> => {
      // An explicit kill switch blocks a consented install. No reader, or an
      // unreadable one, means the switch is on.
      const runtimeEnabled = input.identity
        ? await hqAnywhereRuntimeEnabled(input.identity as IdentityApi)
        : true;
      if (!continueWillInstallHq({ runtime, runtimeEnabled, canInstall: Boolean(settings.installRuntimeForTool) })) {
        return { kind: "not-installing" };
      }
      const optIn = await putHqAnywherePersonSetting(settings as SettingsApi, true, { pause: input.pause });
      if (!optIn.ok) {
        // Without the saved opt-in the next launch would uninstall, so skip the install.
        console.warn("[first-run] HQ Anywhere opt-in was not saved; skipping the install", optIn.message);
        log(`continue-in-tool opt-in failed runtime=${runtime} ms=${Date.now() - startedAt}`);
        return { kind: "opt-in-failed", message: optInNotSavedMessage(runtime) };
      }
      const result = await settings.installRuntimeForTool!(runtime as "claude" | "codex");
      return { kind: "installed", result };
    };
    const { raced, settled } = bounded(
      () =>
        enableStep().catch((error: unknown): EnableStepResult => {
          console.warn("[first-run] HQ Anywhere enable step threw", error);
          return { kind: "installed", result: undefined };
        }),
      input.installWaitMs ?? FIRST_RUN_INSTALL_WAIT_MS,
    );
    const step = await raced;
    if (step === "timeout") {
      installState = "pending";
      console.warn("[first-run] HQ Anywhere setup is still running; landing on the welcome report");
      void settled.then((late) => {
        try {
          // A late opt-in failure or kill switch installed nothing.
          input.onInstallSettled?.(late.kind === "installed" ? late.result : undefined);
        } catch (error) {
          console.warn("[first-run] install follow-up failed", error);
        }
      });
      log(`continue-in-tool installed runtime=${runtime} ok=timeout ms=${Date.now() - startedAt}`);
    } else if (step.kind === "opt-in-failed") {
      notice = step.message;
    } else if (step.kind === "installed") {
      const installed = step.result;
      if (installed?.ok === true) {
        installState = "installed";
      } else {
        installState = "failed";
        if (installed && !installed.ok) console.warn("[first-run] runtime install failed", installed.message);
      }
      log(`continue-in-tool installed runtime=${runtime} ok=${String(installed?.ok ?? "skipped")} ms=${Date.now() - startedAt}`);
    }
  }

  log(`continue-in-tool prepared runtime=${runtime} ms=${Date.now() - startedAt}`);
  if (notice) return { kind: "prepared-without-opt-in", message: notice };
  return { kind: "prepared", install: installState };
}

/**
 * Opens the tool Continue prepared, in the HQ folder. The welcome edition and
 * a later Daily Brief both call this; Continue itself does not.
 */
export async function openPreparedCodingTool(input: {
  runtime: FirstRunRuntime;
  settings: ContinueInToolInput["settings"];
  shell: LaunchShell;
}): Promise<OpenPreparedToolOutcome> {
  const folder = await hqFolder(input.settings);
  if (!folder) {
    console.warn("[brief] no HQ folder to open the coding tool in");
    return { kind: "no-folder" };
  }
  const actions = createLaunchActions({ shell: input.shell, hqFolderPath: folder });
  const error =
    input.runtime === "claude"
      ? await actions.launchClaude()
      : input.runtime === "codex"
        ? await actions.launchCodex()
        : await actions.launchGrok();
  if (error) {
    console.warn("[brief] could not open the coding tool:", error);
    return { kind: "open-failed", message: error };
  }
  return { kind: "opened" };
}

/** What the welcome edition says when there is no HQ folder to open. */
export const WELCOME_HARNESS_NO_FOLDER = "Could not find your HQ folder. Try again in a moment.";

/** The harnesses the desktop app can open from the welcome edition. Cursor opens the HQ folder, without a prompt. */
export const WELCOME_OPENABLE_HARNESSES = ["claude-code", "codex", "cursor"] as const;

/**
 * Opens HQ in the harness a welcome action names, with the action's prompt
 * (US-019). It never reads the tool picked at Continue or the brief's saved
 * engine. Resolves with a plain line when it could not open, else null.
 */
export async function openWelcomeHarness(input: {
  harness: "claude-code" | "codex" | "cursor";
  prompt: string;
  settings: ContinueInToolInput["settings"];
  shell: LaunchShell & Pick<ShellApi, "launchCursorWorkspace">;
}): Promise<string | null> {
  const folder = await hqFolder(input.settings);
  if (!folder) {
    console.warn("[brief] no HQ folder to open the welcome harness in");
    return WELCOME_HARNESS_NO_FOLDER;
  }
  if (input.harness === "cursor") {
    // Cursor takes no first message, so it opens on the HQ folder alone.
    const result = await input.shell.launchCursorWorkspace(folder);
    if (result.ok) return null;
    console.warn("[brief] could not open Cursor:", result.message);
    return "Cursor could not open. Open your HQ folder in Cursor to keep going.";
  }
  const actions = createLaunchActions({
    shell: input.shell,
    hqFolderPath: folder,
    prompt: input.prompt,
    // The terminal CLIs get the prompt too, as their first message.
    terminalPrompt: input.prompt,
  });
  const error = input.harness === "claude-code" ? await actions.launchClaude() : await actions.launchCodex();
  if (!error) return null;
  // The launcher's own copy can quote the prompt; the edition never shows a prompt.
  console.warn("[brief] could not open the welcome harness:", error);
  const name = input.harness === "claude-code" ? "Claude Code" : "Codex";
  return name + " could not open. Open your HQ folder in " + name + " to keep going.";
}
