/**
 * Model for the titlebar "Finishing setup" chip (install-flow-rethink US-005).
 *
 * The native background install queue reports its progress as a
 * `QueueStatus` (camelCase over the wire) both from
 * `get_install_queue_status` and on the `install-queue:progress` event. The
 * chip never blocks anything: it only names the item running now and offers a
 * A failed item is reported through the assistant, never as a count on the chip.
 */

import type { SyncUnlistenFn } from "./sync-events.js";

export const INSTALL_QUEUE_PROGRESS_EVENT = "install-queue:progress";

export type InstallQueueState = "idle" | "running" | "attention" | "complete";

export interface InstallQueueStatus {
  state: InstallQueueState;
  /** Chip label of the item running now, if any. */
  current: string | null;
  currentId: string | null;
  /** Items done or skipped. */
  done: number;
  total: number;
  /** Ids of the items that failed and need attention. */
  failed: string[];
}

/**
 * The host seam the chip reads from. The app builds it over Tauri `invoke`
 * and `listen`; `packages/ui` stays platform-agnostic.
 */
export interface InstallQueueHost {
  getStatus(): Promise<unknown>;
  retry(): Promise<unknown>;
  listen(
    event: string,
    handler: (event: { payload?: unknown }) => void,
  ): Promise<SyncUnlistenFn>;
}

const STATES: readonly InstallQueueState[] = ["idle", "running", "attention", "complete"];

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Parse a wire payload. Returns null for anything that is not a status. */
export function parseInstallQueueStatus(value: unknown): InstallQueueStatus | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.state !== "string" || !STATES.includes(raw.state as InstallQueueState)) {
    return null;
  }
  return {
    state: raw.state as InstallQueueState,
    current: typeof raw.current === "string" && raw.current ? raw.current : null,
    currentId: typeof raw.currentId === "string" && raw.currentId ? raw.currentId : null,
    done: count(raw.done),
    total: count(raw.total),
    failed: Array.isArray(raw.failed)
      ? raw.failed.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/**
 * The chip shows only while the queue is working: progress, never a count
 * of things that need attention (owner, 2026-10-15: "that should be
 * removed"). A failed item is told to the assistant, which says in chat what
 * failed and the one fix (`installQueueAttentionNotice`).
 */
export function finishingSetupVisible(status: InstallQueueStatus | null): boolean {
  return status?.state === "running";
}

/** Plain names for the queue's item ids, for the assistant's note. */
const INSTALL_ITEM_NAMES: Readonly<Record<string, string>> = {
  gh: "the GitHub CLI",
  qmd: "search (qmd)",
  "search-index": "the search index",
  embeddings: "search embeddings",
  "vault-upload": "the first upload to HQ Cloud",
  "hq-cli": "the HQ command line",
  claude: "Claude Code",
  codex: "Codex",
};

export function installItemName(id: string): string {
  return INSTALL_ITEM_NAMES[id] ?? id.replace(/[-_]+/g, " ");
}

/**
 * The bot-only note the assistant gets when background setup items failed:
 * what failed and the one fix. The queue keeps its manifest and resumes the
 * pending items when HQ next launches (install_queue.rs resume_on_launch),
 * so the fix is to quit and reopen HQ. Never raw error output.
 */
export function installQueueAttentionNotice(failed: readonly string[], opts: { noun?: string } = {}): string {
  const noun = opts.noun?.trim() || "computer";
  const names = failed.map(installItemName);
  const list = names.length <= 1 ? (names[0] ?? "a setup item") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return [
    `[HQ desktop] Background setup on this ${noun} did not finish: ${list}.`,
    "HQ resumes the unfinished items the next time it launches.",
    "Tell the person in one plain line what did not finish and that quitting and reopening HQ finishes it. Do not show error text, and do not ask them to run commands.",
  ].join(" ");
}

/** Plain-language chip text. Never includes raw error output. */
export function finishingSetupLabel(status: InstallQueueStatus): string {
  const progress = status.total > 0 ? ` (${Math.min(status.done + 1, status.total)} of ${status.total})` : "";
  return status.current
    ? `Finishing setup: ${status.current}${progress}`
    : `Finishing setup${progress}`;
}

/** Build the host over the app's Tauri `invoke` and `listen`. */
export function createInstallQueueHost(
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>,
  listen: InstallQueueHost["listen"],
): InstallQueueHost {
  return {
    getStatus: () => invoke("get_install_queue_status"),
    retry: () => invoke("retry_install_queue"),
    listen,
  };
}
