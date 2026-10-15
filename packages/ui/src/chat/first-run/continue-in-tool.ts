/**
 * "Continue in <tool>" on the first-run decision screen (US-008).
 *
 * The press is the person's explicit HQ Anywhere opt-in for that tool, so the
 * person setting is written first. The startup reconcile reads the same
 * setting, so an install made here is kept on the next launch instead of
 * being uninstalled. Then the one tool's global runtime is installed (bounded,
 * so a hung `hq install` cannot hold the takeover) and the tool is opened in
 * the HQ folder through the shared launch cascade.
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

/** How long the install may hold "Opening <tool>…" before the tool opens anyway. */
export const FIRST_RUN_INSTALL_WAIT_MS = 20_000;

/** Shown in the takeover when the tool opened but the opt-in was not saved. */
export function optInNotSavedMessage(runtime: FirstRunRuntime): string {
  const tool = runtime === "codex" ? "Codex" : "Claude Code";
  return `Couldn't save your HQ Anywhere choice. ${tool} opened without it; try again from Settings.`;
}

export type ContinueInToolOutcome =
  | { kind: "opened" }
  /** The tool opened, but the opt-in write failed, so nothing was installed. */
  | { kind: "opened-without-opt-in"; message: string }
  /** No HQ folder to open the tool in; the caller takes the chat path. */
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
  const { runtime, settings, shell } = input;
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
  // reconcile never removes hooks, so Continue only opens the tool.
  const runtimeEnabled = input.identity ? await hqAnywhereRuntimeEnabled(input.identity as IdentityApi) : false;
  if (runtime !== "grok" && settings.installRuntimeForTool && runtimeEnabled) {
    const optIn = await putHqAnywherePersonSetting(settings as SettingsApi, true, { pause: input.pause });
    if (!optIn.ok) {
      // Without the saved opt-in the next launch would uninstall, so skip the install.
      console.warn("[first-run] HQ Anywhere opt-in was not saved; opening without the install", optIn.message);
      log(`continue-in-tool opt-in failed runtime=${runtime} ms=${Date.now() - startedAt}`);
      notice = optInNotSavedMessage(runtime);
    } else {
      const installed = await boundedInstall(
        () => settings.installRuntimeForTool!(runtime),
        input.installWaitMs ?? FIRST_RUN_INSTALL_WAIT_MS,
      );
      if (installed === "timeout") console.warn("[first-run] runtime install is still running; opening the tool");
      else if (installed && !installed.ok) console.warn("[first-run] runtime install failed", installed.message);
      const state = installed === "timeout" ? "timeout" : String(installed?.ok ?? "skipped");
      log(`continue-in-tool installed runtime=${runtime} ok=${state} ms=${Date.now() - startedAt}`);
    }
  }

  const actions = createLaunchActions({ shell, hqFolderPath: folder });
  const error =
    runtime === "claude"
      ? await actions.launchClaude()
      : runtime === "codex"
        ? await actions.launchCodex()
        : await actions.launchGrok();
  log(`continue-in-tool opened runtime=${runtime} ok=${!error} ms=${Date.now() - startedAt}`);
  if (error) {
    console.warn("[first-run] could not open the coding tool:", error);
    return { kind: "open-failed", message: error };
  }
  if (notice) return { kind: "opened-without-opt-in", message: notice };
  return { kind: "opened" };
}
