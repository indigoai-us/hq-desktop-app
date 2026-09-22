import { describe, expect, it } from "vitest";
import type { MeetingPermissionsSnapshot } from "@hq/platform";

import {
  meetingDetectionNeedsSetup,
  missingMeetingPermissions,
} from "./meeting-permissions";

function snapshot(
  patch: Partial<MeetingPermissionsSnapshot> = {},
): MeetingPermissionsSnapshot {
  return {
    accessibility: "granted",
    screenCapture: "granted",
    microphone: "granted",
    systemAudio: "granted",
    fullDiskAccess: "unknown",
    allRequiredGranted: true,
    ...patch,
  };
}

describe("missingMeetingPermissions", () => {
  it("is empty when every required permission is granted", () => {
    expect(missingMeetingPermissions(snapshot())).toEqual([]);
  });

  it("names each missing required permission in System Settings order", () => {
    // The field-observed shape: mic granted, the other two never asked for.
    expect(
      missingMeetingPermissions(
        snapshot({
          accessibility: "denied",
          screenCapture: "not-determined",
          allRequiredGranted: false,
        }),
      ),
    ).toEqual(["Accessibility", "Screen Recording"]);
  });

  it("ignores the non-gating permissions", () => {
    expect(
      missingMeetingPermissions(
        snapshot({ systemAudio: "denied", fullDiskAccess: "denied" }),
      ),
    ).toEqual([]);
  });
});

describe("meetingDetectionNeedsSetup", () => {
  it("nudges only on a real snapshot with something missing", () => {
    expect(meetingDetectionNeedsSetup(snapshot())).toBe(false);
    expect(
      meetingDetectionNeedsSetup(snapshot({ allRequiredGranted: false })),
    ).toBe(true);
  });

  it("never nudges when the host cannot report permissions", () => {
    expect(meetingDetectionNeedsSetup(null)).toBe(false);
    expect(meetingDetectionNeedsSetup(undefined)).toBe(false);
  });
});
