import { describe, expect, it } from "vitest";

import {
  pairUnreadsFromInboxPage,
  shouldArmDirectorySafety,
  shouldBumpDmUnread,
  TIMELINE_SAFETY_INTERVAL_MS,
} from "./live-catchup.js";

describe("shouldArmDirectorySafety", () => {
  it("polls only while MQTT is not connected", () => {
    expect(shouldArmDirectorySafety("connected")).toBe(false);
    expect(shouldArmDirectorySafety("reconnecting")).toBe(true);
    expect(shouldArmDirectorySafety("paused-hidden")).toBe(true);
    expect(shouldArmDirectorySafety(undefined)).toBe(true);
    expect(TIMELINE_SAFETY_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe("shouldBumpDmUnread", () => {
  it("bumps Deacon when a project channel is selected", () => {
    expect(
      shouldBumpDmUnread({
        selectedId: "ch:chn_proj",
        fromPersonUid: "agt_deacon",
        selfUid: "prs_stefan",
      }),
    ).toBe(true);
  });

  it("does not bump the open DM or the caller's own send", () => {
    expect(
      shouldBumpDmUnread({
        selectedId: "dm:agt_deacon",
        fromPersonUid: "agt_deacon",
      }),
    ).toBe(false);
    expect(
      shouldBumpDmUnread({
        selectedId: "ch:chn_proj",
        fromPersonUid: "prs_stefan",
        selfUid: "prs_stefan",
      }),
    ).toBe(false);
  });
});

describe("pairUnreadsFromInboxPage", () => {
  it("establishes a since cursor on first page without incrementing", () => {
    expect(
      pairUnreadsFromInboxPage({
        events: [
          {
            fromPersonUid: "prs_b",
            createdAt: "2026-08-18T12:00:00.000Z",
          },
        ],
      }),
    ).toEqual({ nextSince: "2026-08-18T12:00:00.000Z" });
  });

  it("increments only new inbound events once a since cursor exists", () => {
    expect(
      pairUnreadsFromInboxPage(
        {
          events: [
            {
              fromPersonUid: "prs_b",
              createdAt: "2026-08-18T13:00:00.000Z",
            },
          ],
        },
        { since: "2026-08-18T12:00:00.000Z", selfUid: "prs_me" },
      ),
    ).toEqual({
      pairUnreads: [{ withPersonUid: "prs_b", unreadCount: 1 }],
      nextSince: "2026-08-18T13:00:00.000Z",
      delta: true,
    });
  });

  it("uses server pairUnreads when the inbox page names Deacon", () => {
    expect(
      pairUnreadsFromInboxPage(
        {
          events: [
            {
              fromPersonUid: "agt_deacon",
              createdAt: "2026-08-22T19:59:22.000Z",
            },
          ],
          pairUnreads: [{ withPersonUid: "agt_deacon", unreadCount: 1 }],
        },
        { since: "2026-08-22T19:58:50.000Z" },
      ),
    ).toEqual({
      pairUnreads: [{ withPersonUid: "agt_deacon", unreadCount: 1 }],
      nextSince: "2026-08-22T19:59:22.000Z",
    });
  });
});
