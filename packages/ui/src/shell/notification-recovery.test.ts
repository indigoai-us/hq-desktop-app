import { describe, expect, it } from "vitest";

import { recoveryFromEvent } from "./notification-recovery.js";

describe("recoveryFromEvent", () => {
  it("reads a complete record", () => {
    expect(
      recoveryFromEvent({
        recovery: {
          kind: "share",
          action: "open",
          data: { eventId: "evt_1" },
          message: "Couldn’t finish the shared-item action. Retry it here.",
        },
        retrying: true,
      }),
    ).toEqual({
      recovery: {
        kind: "share",
        action: "open",
        data: { eventId: "evt_1" },
        message: "Couldn’t finish the shared-item action. Retry it here.",
      },
      retrying: true,
    });
  });

  it("treats a cleared record as nothing to recover", () => {
    expect(recoveryFromEvent({ recovery: null, retrying: false })).toEqual({
      recovery: null,
      retrying: false,
    });
  });

  it("supplies the kind's copy when the message is missing", () => {
    const parsed = recoveryFromEvent({
      recovery: { kind: "dm", action: "open", data: null },
      retrying: false,
    });
    expect(parsed?.recovery?.message).toBe(
      "Couldn’t finish the message action. Retry it here.",
    );
  });

  it("rejects a record whose action cannot be retried", () => {
    // A banner whose Retry has no action to re-run is a dead control.
    expect(
      recoveryFromEvent({ recovery: { kind: "dm", action: "  " } }),
    ).toEqual({ recovery: null, retrying: false });
    expect(recoveryFromEvent({ recovery: { action: "open" } })).toEqual({
      recovery: null,
      retrying: false,
    });
  });

  it("ignores a payload that is not an event record at all", () => {
    expect(recoveryFromEvent(undefined)).toBeNull();
    expect(recoveryFromEvent("open")).toBeNull();
  });

  it("passes the retrying flag through verbatim; the consumer gates it on the record", () => {
    expect(recoveryFromEvent({ recovery: null, retrying: true })).toEqual({
      recovery: null,
      retrying: true,
    });
  });
});
