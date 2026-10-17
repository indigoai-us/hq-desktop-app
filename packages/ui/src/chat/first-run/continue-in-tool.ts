/**
 * "Continue in <tool>" on the first-run decision screen (US-008).
 *
 * HQ Anywhere is installed only after the person presses Enable on the
 * callout. That press is the explicit opt-in, so the person setting is
 * written first. The startup reconcile reads the same setting, so an install
 * made here is kept on the next launch instead of being uninstalled. Then
 * the one tool's global runtime is installed (bounded, so a hung `hq install`
 * cannot hold the takeover). A wait that runs out is pending, not failed:
 * the install keeps running and reports its real result later. Not now, or
 * no callout, installs nothing. The tool stays closed: the welcome edition,
 * and later the Daily Brief, open it when the person presses Open.
 */

import {
  hqAnywhereRuntimeEnabled,
  putHqAnywherePersonSetting,
  type AdapterResult,
  type IdentityApi,
  type SettingsApi,
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

/**
 * Resolves with the install result, or "timeout" once the wait runs out.
 * The install itself is not cancelled: `settled` is that same promise.
 */
function boundedInstall(
  install: () => Promise<AdapterResult<void> | undefined>,
  waitMs: number,
): {
  raced: Promise<AdapterResult<void> | undefined | "timeout">;
  settled: Promise<AdapterResult<void> | undefined>;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  const settled = install().catch((error: unknown) => {
    console.warn("[first-run] runtime install threw", error);
    return undefined;
  });
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
  // the opt-in and the install. An explicit kill switch still blocks a
  // consented install. No reader, or an unreadable one, means the switch is on.
  const runtimeEnabled = input.enableHqAnywhere !== true
    ? false
    : input.identity
      ? await hqAnywhereRuntimeEnabled(input.identity as IdentityApi)
      : true;
  if (
    input.enableHqAnywhere === true &&
    continueWillInstallHq({ runtime, runtimeEnabled, canInstall: Boolean(settings.installRuntimeForTool) })
  ) {
    const optIn = await putHqAnywherePersonSetting(settings as SettingsApi, true, { pause: input.pause });
    if (!optIn.ok) {
      // Without the saved opt-in the next launch would uninstall, so skip the install.
      console.warn("[first-run] HQ Anywhere opt-in was not saved; skipping the install", optIn.message);
      log(`continue-in-tool opt-in failed runtime=${runtime} ms=${Date.now() - startedAt}`);
      notice = optInNotSavedMessage(runtime);
    } else {
      const { raced, settled } = boundedInstall(
        () => settings.installRuntimeForTool!(runtime as "claude" | "codex"),
        input.installWaitMs ?? FIRST_RUN_INSTALL_WAIT_MS,
      );
      const installed = await raced;
      if (installed === "timeout") {
        installState = "pending";
        console.warn("[first-run] runtime install is still running; landing on the welcome report");
        void settled.then((result) => {
          try {
            input.onInstallSettled?.(result);
          } catch (error) {
            console.warn("[first-run] install follow-up failed", error);
          }
        });
      } else if (installed?.ok === true) {
        installState = "installed";
      } else {
        installState = "failed";
        if (installed && !installed.ok) console.warn("[first-run] runtime install failed", installed.message);
      }
      const state = installed === "timeout" ? "timeout" : String(installed?.ok ?? "skipped");
      log(`continue-in-tool installed runtime=${runtime} ok=${state} ms=${Date.now() - startedAt}`);
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
