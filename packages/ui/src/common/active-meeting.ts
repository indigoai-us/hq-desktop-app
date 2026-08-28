/**
 * Structural types for the live meeting monitor (LiveNowCard). Ported from
 * the desktop app's `lib/activeMeetings.ts` / `lib/recordingCompany.ts` so
 * packages/ui stays self-contained; hosts map their wire rows onto these.
 */

export type ActiveMeetingState =
  "detected" | "starting" | "recording" | "stopping" | "error";

export interface ActiveMeeting {
  windowId: string;
  platform: string;
  meetingUrl: string;
  detectedAt: string;
  state: ActiveMeetingState;
  recordingId?: string;
  error?: string;
  companyUid: string | null;
  /** True once the user has explicitly picked a company for this row (incl. an
   *  explicit "Personal" = null). Guards the resolved-default + back-fill paths
   *  from clobbering a deliberate choice. */
  companyUserSet?: boolean;
  summary?: string;
  sourceEventId?: string;
}

/**
 * Membership subset driving the per-meeting "Record as" picker. Compatible
 * with the desktop-alt meetings model's `CompanyMembership` rows.
 */
export interface RecordingMembership {
  companyUid: string;
  companyName?: string | null;
  role?: string | null;
  status: string;
}
