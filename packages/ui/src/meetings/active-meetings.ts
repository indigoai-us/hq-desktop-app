/**
 * Active-meetings state — the pure-UI port of desktop `lib/activeMeetings.ts`.
 *
 * The desktop original owns the live `meeting:detected` Tauri event channel
 * plus `start_recording` / `stop_recording` invokes. None of that exists in
 * the pure UI package: there is no PlatformAdapter surface for live meeting
 * detection yet, so this module keeps only the platform-free parts —
 *
 *  - the `ActiveMeeting` row type,
 *  - the `activeMeetings` / `recordingMemberships` writables, and
 *  - the pure upsert/update/remove reducers over them
 *
 * — and exposes an injectable `RecordingControls` seam for hosts that CAN
 * drive detection/recording (the desktop app feeds the writables from its
 * event listeners and injects real controls). Without an injected control the
 * start/stop/company functions are safe no-ops: the LiveNowCard simply never
 * shows a detected row on hosts that cannot detect meetings, so there are no
 * dead buttons.
 */

import { writable } from "svelte/store";
import type {
  ActiveMeeting,
  ActiveMeetingState,
  RecordingMembership,
} from "../common/active-meeting";

export type { ActiveMeeting, ActiveMeetingState, RecordingMembership };

export const activeMeetings = writable<ActiveMeeting[]>([]);
export const recordingMemberships = writable<RecordingMembership[]>([]);

/** Idempotent upsert keyed by windowId. A re-detection never downgrades an
 *  in-flight recording back to `detected` (preserves state/recordingId/error
 *  while still taking fresher metadata such as `summary`). */
export function upsertActiveMeeting(meeting: ActiveMeeting): void {
  activeMeetings.update((rows) => {
    const idx = rows.findIndex((row) => row.windowId === meeting.windowId);
    if (idx < 0) return [...rows, meeting];
    const next = rows.slice();
    const existing = rows[idx];
    next[idx] =
      meeting.state === "detected" && existing.state !== "detected"
        ? {
            ...meeting,
            state: existing.state,
            recordingId: existing.recordingId,
            error: existing.error,
          }
        : meeting;
    return next;
  });
}

export function updateActiveMeeting(
  windowId: string,
  patch: Partial<ActiveMeeting>,
): void {
  activeMeetings.update((rows) =>
    rows.map((row) => (row.windowId === windowId ? { ...row, ...patch } : row)),
  );
}

export function removeActiveMeeting(windowId: string): void {
  activeMeetings.update((rows) =>
    rows.filter((row) => row.windowId !== windowId),
  );
}

// ---------------------------------------------------------------------------
// Host-injected recording controls (desktop only).
// ---------------------------------------------------------------------------

export interface RecordingControls {
  startRecording(windowId: string): Promise<void>;
  stopRecording(windowId: string): Promise<void>;
  setRecordingCompany(windowId: string, companyUid: string | null): void;
}

let controls: RecordingControls | null = null;

/** Inject platform recording controls (desktop host). `null` restores no-ops. */
export function configureRecordingControls(
  next: RecordingControls | null,
): void {
  controls = next;
}

export async function startRecording(windowId: string): Promise<void> {
  if (!controls) {
    console.warn("startRecording: no recording controls on this platform");
    return;
  }
  await controls.startRecording(windowId);
}

export async function stopRecording(windowId: string): Promise<void> {
  if (!controls) {
    console.warn("stopRecording: no recording controls on this platform");
    return;
  }
  await controls.stopRecording(windowId);
}

export function setRecordingCompany(
  windowId: string,
  companyUid: string | null,
): void {
  if (controls) {
    controls.setRecordingCompany(windowId, companyUid);
    return;
  }
  // Still reflect the choice locally so the picker is not a dead control.
  updateActiveMeeting(windowId, { companyUid, companyUserSet: true });
}
