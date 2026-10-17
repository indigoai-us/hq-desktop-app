/**
 * "Continue in <tool>" on the first-run decision screen (US-008).
 *
 * The press is the person's explicit HQ Anywhere opt-in for that tool, so the
 * person setting is written first. The startup reconcile reads the same
 * setting, so an install made here is kept on the next launch instead of
 * being uninstalled. Then the one tool's global runtime is installed (bounded,
 * so a hung `hq install` cannot hold the takeover). The tool stays closed:
 * the welcome edition, and later the Daily Brief, open it when the person
 * presses Open.
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

export type ContinueInToolOutcome =
  /** Opt-in and install finished (or were skipped). The tool was not opened. */
  | { kind: "prepared" }
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
  shell: LaunchShell;
  /** Resolves the hq-anywhere-runtime kill switch; missing means off. */
  identity?: Pick<IdentityApi, "resolveFeatureFlagStatus">;
  log?: (message: string) => void;
  /** Test seam. */
  installWaitMs?: number;
  /** Test seam: the opt-in write's retry pause. */
  pause?: (milliseconds: number) => Promise<void>;
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

/** Resolves with the install result, or "timeout" once the wait runs out. */
function boundedInstall(
  install: () => Promise<AdapterResult<void> | undefined>,
  waitMs: number,
): Promise<AdapterResult<void> | undefined | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), waitMs);
  });
  const run = install().catch((error: unknown) => {
    console.warn("[first-run] runtime install threw", error);
    return undefined;
  });
  return Promise.race([run, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  // The admin kill switch gates every install and reconcile; with it off the
  // reconcile never removes hooks, so Continue changes nothing in the tool.
  const runtimeEnabled = input.identity ? await hqAnywhereRuntimeEnabled(input.identity as IdentityApi) : false;
  if (runtime !== "grok" && settings.installRuntimeForTool && runtimeEnabled) {
    const optIn = await putHqAnywherePersonSetting(settings as SettingsApi, true, { pause: input.pause });
    if (!optIn.ok) {
      // Without the saved opt-in the next launch would uninstall, so skip the install.
      console.warn("[first-run] HQ Anywhere opt-in was not saved; skipping the install", optIn.message);
      log(`continue-in-tool opt-in failed runtime=${runtime} ms=${Date.now() - startedAt}`);
      notice = optInNotSavedMessage(runtime);
    } else {
      const installed = await boundedInstall(
        () => settings.installRuntimeForTool!(runtime),
        input.installWaitMs ?? FIRST_RUN_INSTALL_WAIT_MS,
      );
      if (installed === "timeout") console.warn("[first-run] runtime install is still running; landing on the welcome report");
      else if (installed && !installed.ok) console.warn("[first-run] runtime install failed", installed.message);
      const state = installed === "timeout" ? "timeout" : String(installed?.ok ?? "skipped");
      log(`continue-in-tool installed runtime=${runtime} ok=${state} ms=${Date.now() - startedAt}`);
    }
  }

  log(`continue-in-tool prepared runtime=${runtime} ms=${Date.now() - startedAt}`);
  if (notice) return { kind: "prepared-without-opt-in", message: notice };
  return { kind: "prepared" };
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
