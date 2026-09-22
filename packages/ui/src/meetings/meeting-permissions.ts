import type { MeetingPermissionsSnapshot } from "@hq/platform";

/**
 * The macOS permissions the desktop meeting detector cannot run without, in
 * the order System Settings lists them. Full Disk Access and system audio
 * are reported by the host but never gate detection, so they are not here.
 */
const REQUIRED: ReadonlyArray<{
  key: keyof Pick<
    MeetingPermissionsSnapshot,
    "accessibility" | "screenCapture" | "microphone"
  >;
  label: string;
}> = [
  { key: "accessibility", label: "Accessibility" },
  { key: "screenCapture", label: "Screen Recording" },
  { key: "microphone", label: "Microphone" },
];

/**
 * Human labels for every required permission that is not granted, so a
 * "detection is off" nudge can say exactly what to flip on. Empty when the
 * detector is allowed to run.
 */
export function missingMeetingPermissions(
  snapshot: MeetingPermissionsSnapshot,
): string[] {
  return REQUIRED.filter(({ key }) => snapshot[key] !== "granted").map(
    ({ label }) => label,
  );
}

/**
 * True when the host reports a real snapshot whose required permissions are
 * not all granted — the one case where the app should nudge the person to
 * the Meeting Permissions setup. A missing snapshot (host cannot detect
 * meetings, or the read failed) is never a nudge.
 */
export function meetingDetectionNeedsSetup(
  snapshot: MeetingPermissionsSnapshot | null | undefined,
): boolean {
  return Boolean(snapshot) && !snapshot!.allRequiredGranted;
}
