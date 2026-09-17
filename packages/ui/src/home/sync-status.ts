/**
 * Sync state for the title bar, reduced from the runner's event stream.
 *
 * The popover carried this and the main window did not, which is why closing
 * the popover would have taken away the only place a sync could be seen
 * happening. This is the model half — pure, so the counting is testable without
 * mounting a title bar.
 *
 * The runner does not emit a progress total. `sync:plan` announces how many
 * files a company's run intends to move, and `sync:progress` then fires once
 * per file. "3 of 28 transferred" is those two combined, which is why this has
 * to be a reducer rather than a field read off one event.
 */

export type SyncPhase =
  | "idle"
  | "syncing"
  | "auth-error"
  | "conflict"
  | "error";

export interface SyncStatusState {
  phase: SyncPhase;
  /** Files this run intends to move, summed across companies. 0 = unknown. */
  planTotal: number;
  /** Files moved so far this run. */
  progressed: number;
  /** Company whose files are moving right now, for the caption. */
  company: string | null;
  /** Set on auth-error / conflict / error; cleared when a run starts. */
  message: string | null;
}

export function emptySyncStatus(): SyncStatusState {
  return {
    phase: "idle",
    planTotal: 0,
    progressed: 0,
    company: null,
    message: null,
  };
}

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Fold one runner event into the state.
 *
 * Unknown events return the SAME object, not a copy, so a caller driving Svelte
 * state can assign unconditionally without invalidating the subtree on every
 * unrelated sync event — and the runner emits a lot of them.
 */
export function reduceSyncEvent(
  state: SyncStatusState,
  event: string,
  payload?: unknown,
): SyncStatusState {
  const data = asRecord(payload);

  switch (event) {
    case "sync:plan": {
      // Plans arrive per company and a run can cover several, so totals
      // accumulate rather than replace. Skipped files are not moved, so they
      // are not counted; deletes are, because the runner reports one progress
      // event for each.
      const planned =
        asCount(data.filesToDownload) +
        asCount(data.filesToUpload) +
        asCount(data.filesToDelete);
      return {
        ...state,
        phase: "syncing",
        planTotal: state.planTotal + planned,
        company: asText(data.company) ?? state.company,
        message: null,
      };
    }

    case "sync:progress": {
      return {
        ...state,
        phase: "syncing",
        progressed: state.progressed + 1,
        company: asText(data.company) ?? state.company,
        message: null,
      };
    }

    case "sync:auth-error":
      return {
        ...state,
        phase: "auth-error",
        message:
          asText(data.message) ??
          "Your HQ session needs a refresh. Sign in again to keep sync moving.",
      };

    case "sync:conflict":
      return { ...state, phase: "conflict", message: asText(data.message) };

    case "sync:error":
      return {
        ...state,
        phase: "error",
        message: asText(data.message) ?? "Sync ran into a problem.",
      };

    case "sync:all-complete":
      // Counters reset here, not on `sync:complete`: that one fires per company
      // and a multi-company run would zero the totals partway through, so the
      // caption would count up, restart, and count up again.
      return emptySyncStatus();

    default:
      return state;
  }
}

/** Events a host must subscribe to for this reducer to be correct. */
export const SYNC_STATUS_EVENTS = [
  "sync:plan",
  "sync:progress",
  "sync:auth-error",
  "sync:conflict",
  "sync:error",
  "sync:all-complete",
] as const;

export interface SyncStatusLabel {
  /** Short line for the title bar. Null when there is nothing worth saying. */
  text: string | null;
  /** Long form for the tooltip and the accessible name. */
  detail: string;
  tone: "busy" | "attention" | "idle";
}

/**
 * Title-bar label.
 *
 * Progress ONLY. Attention states (auth-error, conflict, error) are already
 * owned by the Core pill's dot tone and the sentence inside the Core popover
 * (`corePillDotTone`, `getV4TitleBarModel`), so repeating them here would give
 * the same problem two warning lights in one bar and make it ambiguous which
 * one to act on. The phases are still reduced and carried in state — a caller
 * that wants them has them; the title bar just does not draw them.
 *
 * Idle says nothing at all, matching D-04's "hide idle sync chrome": a
 * permanent "All synced" chip is correct almost always and therefore stops
 * being read.
 */
export function syncStatusLabel(state: SyncStatusState): SyncStatusLabel {
  switch (state.phase) {
    case "syncing": {
      // A plan of 0 means no plan arrived yet (or an older runner sent none).
      // Counting up without a denominator is honest; inventing one is not.
      const text =
        state.planTotal > 0
          ? `${state.progressed.toLocaleString()} of ${state.planTotal.toLocaleString()}`
          : state.progressed > 0
            ? `${state.progressed.toLocaleString()} files`
            : "Starting…";
      return {
        text,
        detail: state.company ? `Syncing ${state.company}` : "Syncing",
        tone: "busy",
      };
    }
    case "auth-error":
    case "conflict":
    case "error":
      // Deliberately silent: the Core pill's dot already carries these, and its
      // popover carries the sentence and the recovery action.
      return {
        text: null,
        detail: state.message ?? "Sync needs attention",
        tone: "attention",
      };
    case "idle":
    default:
      return { text: null, detail: "Sync is up to date", tone: "idle" };
  }
}
