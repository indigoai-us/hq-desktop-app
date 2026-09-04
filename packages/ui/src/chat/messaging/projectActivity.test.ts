import { describe, expect, it } from "vitest";

import {
  ACTIVITY_EVENT_PREFIX,
  activityTimelineMessages,
  groupActivityBursts,
  isActivityMessage,
  mergeActivityIntoTimeline,
  projectActivityEntries,
} from "./projectActivity";
import {
  normalizeWorkMeshEvent,
  parseWorkSessionEvent,
  taskStatusLabel,
} from "./workSessionEvent";

/** A real v1 row, copied from GET /v1/work-mesh/threads/{id}/events (hq-prod). */
const v1Progress = {
  itemType: "WORK_THREAD_EVENT",
  pk: "THREAD#3e5d9219",
  sk: "EVT#2026-09-02T14:54:20.682Z#5dc292c7",
  threadId: "3e5d9219",
  eventId: "5dc292c7",
  eventKind: "progress",
  authorUid: "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y",
  authorType: "human",
  createdAt: "2026-09-02T14:54:20.682Z",
  companyUid: "cmp_01KQ2RYAHXHDPCTY9GPQPTH3DG",
  payload: {
    kind: "progress",
    summary: "Pulling latest main and building local unsigned .deb for testing",
  },
};

const v1Claim = {
  eventKind: "claim",
  eventId: "04b5b15e",
  threadId: "3e5d9219",
  authorUid: "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y",
  authorType: "human",
  createdAt: "2026-08-21T12:14:19.235Z",
  payload: {
    kind: "claim",
    claimedBy: "shahzaib@vyg.ai",
    leaseTtlIso: "2026-08-21T14:14:19.072Z",
    note: "Starting HQ project work.",
  },
};

/** A v2 Work Mesh Live session event (session-event.schema.json). */
const v2TaskStatus = {
  v: 1,
  eventId: "01JQ2RYAHXHDPCTY9GPQPTH3DG",
  kind: "task_status",
  sessionId: "01a05ddd-f22f-7881",
  harness: "claude-code",
  adapterVersion: "1.4.0",
  at: "2026-09-03T09:00:00.000Z",
  seq: 7,
  taskId: "US-004",
  status: "in_progress",
  summary: "Picked up the live read",
};

describe("normalizeWorkMeshEvent — v1 envelope", () => {
  it("reads a v1 progress row", () => {
    const row = normalizeWorkMeshEvent(v1Progress);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("progress");
    expect(row?.verb).toBe("made progress on");
    expect(row?.at).toBe("2026-09-02T14:54:20.682Z");
    expect(row?.actorType).toBe("human");
    expect(row?.summary).toBe(
      "Pulling latest main and building local unsigned .deb for testing",
    );
  });

  it("never renders a raw prs_ uid as the actor", () => {
    expect(normalizeWorkMeshEvent(v1Progress)?.actor).toBe("A teammate");
  });

  it("prefers a roster-resolved actor name", () => {
    const row = normalizeWorkMeshEvent(v1Progress, {
      resolveActor: (uid) =>
        uid === "prs_01KRKKKZYQM2SS0TWMG7NRKY0Y" ? "Shahzaib" : null,
    });
    expect(row?.actor).toBe("Shahzaib");
  });

  it("falls back to claimedBy on a claim row", () => {
    expect(normalizeWorkMeshEvent(v1Claim)?.actor).toBe("shahzaib@vyg.ai");
  });

  it("keeps every v1 kind that has a row", () => {
    for (const eventKind of [
      "claim",
      "progress",
      "blocked",
      "question",
      "answer",
      "handoff",
      "done",
      "note",
      "mention",
    ]) {
      const row = normalizeWorkMeshEvent({
        eventKind,
        eventId: `e-${eventKind}`,
        createdAt: "2026-09-01T00:00:00.000Z",
        payload: {},
      });
      expect(row, eventKind).not.toBeNull();
    }
  });
});

describe("normalizeWorkMeshEvent — v2 envelope", () => {
  it("reads a v2 task_status event as a board move", () => {
    const row = normalizeWorkMeshEvent(v2TaskStatus);
    expect(row?.kind).toBe("task_status");
    expect(row?.taskStatus).toEqual({
      taskId: "US-004",
      from: null,
      to: "in_progress",
    });
    expect(row?.harness).toBe("claude-code");
    expect(row?.at).toBe("2026-09-03T09:00:00.000Z");
    expect(row?.threadId).toBe("01a05ddd-f22f-7881");
  });

  it("maps session_start / session_end onto start / done", () => {
    expect(
      normalizeWorkMeshEvent({ ...v2TaskStatus, kind: "session_start" })?.kind,
    ).toBe("start");
    expect(
      normalizeWorkMeshEvent({ ...v2TaskStatus, kind: "session_end" })?.kind,
    ).toBe("done");
  });

  it("drops per-turn noise", () => {
    expect(
      normalizeWorkMeshEvent({ ...v2TaskStatus, kind: "turn_start" }),
    ).toBeNull();
    expect(
      normalizeWorkMeshEvent({ ...v2TaskStatus, kind: "turn_end" }),
    ).toBeNull();
  });

  it("carries a v2 blocked reason into the summary", () => {
    const row = normalizeWorkMeshEvent({
      ...v2TaskStatus,
      kind: "blocked",
      status: undefined,
      reason: "waiting on hq-pro deploy",
    });
    expect(row?.kind).toBe("blocked");
    expect(row?.summary).toBe("waiting on hq-pro deploy");
  });

  it("returns null — never throws — for junk", () => {
    for (const junk of [null, undefined, 42, "x", {}, { kind: "nope" }, []]) {
      expect(normalizeWorkMeshEvent(junk)).toBeNull();
    }
  });
});

describe("taskStatusLabel", () => {
  it("maps wire statuses onto the board columns", () => {
    expect(taskStatusLabel("queued")).toBe("To do");
    expect(taskStatusLabel("in_progress")).toBe("Doing");
    expect(taskStatusLabel("review")).toBe("Waiting");
    expect(taskStatusLabel("done")).toBe("Done");
  });

  it("passes an unknown status through instead of blanking the row", () => {
    expect(taskStatusLabel("parked")).toBe("parked");
  });
});

describe("projectActivityEntries", () => {
  it("orders every thread's events oldest → newest", () => {
    const entries = projectActivityEntries([
      { threadId: "t2", events: [v1Progress] },
      { threadId: "t1", events: [v1Claim] },
    ]);
    expect(entries.map((e) => e.eventId)).toEqual(["04b5b15e", "5dc292c7"]);
  });

  it("dedupes a re-delivered event id", () => {
    const entries = projectActivityEntries([
      { threadId: "t1", events: [v1Claim, { ...v1Claim }] },
    ]);
    expect(entries).toHaveLength(1);
  });

  it("stamps the owning thread id when the event omits it", () => {
    const entries = projectActivityEntries([
      { threadId: "thread-9", events: [{ ...v1Claim, threadId: undefined }] },
    ]);
    expect(entries[0]?.threadId).toBe("thread-9");
  });

  it("skips unparseable rows rather than dropping the whole thread", () => {
    const entries = projectActivityEntries([
      { threadId: "t1", events: [{ nope: true }, v1Claim] },
    ]);
    expect(entries).toHaveLength(1);
  });
});

describe("groupActivityBursts", () => {
  const progressAt = (iso: string, eventId: string) => ({
    ...v1Progress,
    eventId,
    createdAt: iso,
  });

  it("collapses same-actor progress inside the window", () => {
    const entries = groupActivityBursts(
      projectActivityEntries([
        {
          threadId: "t1",
          events: [
            progressAt("2026-09-02T14:00:00.000Z", "a"),
            progressAt("2026-09-02T14:01:00.000Z", "b"),
            progressAt("2026-09-02T14:02:00.000Z", "c"),
          ],
        },
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.burstCount).toBe(3);
    expect(entries[0]?.eventId).toBe("c");
  });

  it("does not collapse across the window", () => {
    const entries = groupActivityBursts(
      projectActivityEntries([
        {
          threadId: "t1",
          events: [
            progressAt("2026-09-02T14:00:00.000Z", "a"),
            progressAt("2026-09-02T14:30:00.000Z", "b"),
          ],
        },
      ]),
    );
    expect(entries).toHaveLength(2);
  });

  it("never collapses blocked or task_status", () => {
    const blocked = (eventId: string, iso: string) => ({
      eventKind: "blocked",
      eventId,
      createdAt: iso,
      authorUid: "prs_1",
      payload: { kind: "blocked", reason: "stuck" },
    });
    const entries = groupActivityBursts(
      projectActivityEntries([
        {
          threadId: "t1",
          events: [
            blocked("a", "2026-09-02T14:00:00.000Z"),
            blocked("b", "2026-09-02T14:00:30.000Z"),
          ],
        },
      ]),
    );
    expect(entries).toHaveLength(2);
  });
});

describe("activityTimelineMessages", () => {
  const entries = groupActivityBursts(
    projectActivityEntries([{ threadId: "t1", events: [v1Claim, v1Progress] }]),
  );

  it("produces bodies the channel timeline already knows how to render", () => {
    const rows = activityTimelineMessages(entries);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const activity = parseWorkSessionEvent(row.body ?? "");
      expect(activity).not.toBeNull();
    }
  });

  it("round-trips the summary and the actor", () => {
    const row = activityTimelineMessages(entries)[1];
    const activity = parseWorkSessionEvent(row.body ?? "");
    expect(activity?.kind).toBe("progress");
    expect(activity?.summary).toBe(
      "Pulling latest main and building local unsigned .deb for testing",
    );
  });

  it("round-trips a v2 board move through the body envelope", () => {
    const rows = activityTimelineMessages(
      projectActivityEntries([{ threadId: "s1", events: [v2TaskStatus] }]),
    );
    const activity = parseWorkSessionEvent(rows[0].body ?? "");
    expect(activity?.kind).toBe("task_status");
    expect(activity?.taskStatus?.to).toBe("in_progress");
    expect(activity?.storyId).toBe("US-004");
  });

  it("namespaces synthetic ids so they cannot collide with chat", () => {
    const rows = activityTimelineMessages(entries);
    expect(rows.every((r) => r.eventId.startsWith(ACTIVITY_EVENT_PREFIX))).toBe(
      true,
    );
    expect(rows.every(isActivityMessage)).toBe(true);
    expect(isActivityMessage({ eventId: "evt_real" })).toBe(false);
  });
});

describe("mergeActivityIntoTimeline", () => {
  const chat = [
    { eventId: "m1", createdAt: "2026-09-02T13:00:00.000Z", body: "hi" },
    { eventId: "m2", createdAt: "2026-09-02T15:00:00.000Z", body: "bye" },
  ];

  it("interleaves activity by timestamp", () => {
    const activity = activityTimelineMessages(
      projectActivityEntries([{ threadId: "t1", events: [v1Progress] }]),
    );
    const merged = mergeActivityIntoTimeline(chat, activity);
    expect(merged.map((m) => m.eventId)).toEqual([
      "m1",
      `${ACTIVITY_EVENT_PREFIX}5dc292c7`,
      "m2",
    ]);
  });

  it("returns chat untouched when there is no activity", () => {
    expect(mergeActivityIntoTimeline(chat, [])).toEqual(chat);
  });

  it("puts chat before activity on an exact timestamp tie", () => {
    const activity = activityTimelineMessages(
      projectActivityEntries([
        {
          threadId: "t1",
          events: [{ ...v1Progress, createdAt: "2026-09-02T13:00:00.000Z" }],
        },
      ]),
    );
    expect(mergeActivityIntoTimeline(chat, activity)[0].eventId).toBe("m1");
  });
});
