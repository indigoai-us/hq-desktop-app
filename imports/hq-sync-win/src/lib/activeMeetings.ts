//! Active-meeting recording model — the typed contract shared between
//! MeetingsWindow.svelte (which owns the live `$state` + Tauri `invoke` surface)
//! and the pure helper modules (`stopWatchdog.ts`, `recordingCompany.ts`).
//!
//! NOTE: the upstream macOS build keeps the live store (Svelte writable +
//! listeners + start/stop IPC) in this module. On the Windows fork the
//! MeetingsWindow component owns that state directly (it is the only window
//! that renders meeting detection), so here we export only the *types* — the
//! decisions live in the pure modules and the wiring lives in the component.
//! Keeping the module name/`ActiveMeetingState` export identical to upstream
//! preserves `stopWatchdog.ts`'s import contract.

/** Lifecycle state of a detected meeting's recording, as rendered in the
 *  MeetingsWindow "live now" rows.
 *
 *  - `detected`  — the SDK saw a meeting window; not recording yet.
 *  - `starting`  — start_recording invoked; awaiting the SDK `recording:started`.
 *  - `recording` — the SDK confirmed the recording is live.
 *  - `stopping`  — stop_recording invoked; awaiting `recording:ended` (a stop
 *                  watchdog backstops this so it can't hang — see stopWatchdog.ts).
 *  - `error`     — a start/stop failed, or the watchdog escalated a stuck stop.
 */
export type ActiveMeetingState = "detected" | "starting" | "recording" | "stopping" | "error";

/** One detected meeting the user can record, keyed by the SDK `windowId`. */
export interface ActiveMeeting {
  windowId: string;
  platform: string;
  meetingUrl: string;
  detectedAt: string;
  state: ActiveMeetingState;
  recordingId?: string;
  error?: string;
  /** Resolved company UID this recording is/was attributed to. `null` =
   *  Personal. Preset from the default; overridable per-recording. */
  companyUid: string | null;
  /** True once the user has explicitly picked a company for this row (incl. an
   *  explicit "Personal" = null). Guards the resolved-default + back-fill paths
   *  from clobbering a deliberate choice. */
  companyUserSet?: boolean;
  summary?: string;
  sourceEventId?: string;
}
