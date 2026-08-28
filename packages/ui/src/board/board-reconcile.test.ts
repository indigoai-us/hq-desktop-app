import { describe, expect, it } from "vitest";

import { applyBoardReconcile, isWorkSessionTopic } from "./board-reconcile";
import type { WorkMeshThread } from "./thread-model";

describe("isWorkSessionTopic", () => {
  it("matches only the exact hq/{uid}/work-session/... shape", () => {
    expect(isWorkSessionTopic("hq/prs_bob/work-session/sess-1")).toBe(true);
    expect(isWorkSessionTopic("hq/prs_bob/work-session/a/b")).toBe(true);
  });

  it("never matches thread topics whose id contains the substring (regression)", () => {
    // A substring check would flip the session feed off polling for these.
    expect(
      isWorkSessionTopic("hq/cmp_acme/thread/proj/work-session-notes"),
    ).toBe(false);
    expect(isWorkSessionTopic("hq/cmp_acme/thread/work-session")).toBe(false);
    expect(isWorkSessionTopic("hq/prs_bob/work-session")).toBe(false); // no id
    expect(isWorkSessionTopic("hq/prs_bob/work-session/")).toBe(false);
    expect(isWorkSessionTopic("hq//work-session/x")).toBe(false);
    expect(isWorkSessionTopic("nope/prs_bob/work-session/x")).toBe(false);
    expect(isWorkSessionTopic("hq/prs_bob/work")).toBe(false);
  });
});

function thread(overrides: Partial<WorkMeshThread> = {}): WorkMeshThread {
  return {
    threadId: "T-1",
    companyUid: "cmp_acme",
    project: "p",
    title: "t",
    status: "progress",
    storyId: null,
    updatedAt: null,
    actor: null,
    note: null,
    ...overrides,
  };
}

describe("applyBoardReconcile", () => {
  it("thread:* upserts the normalized detail and emits thread:reconciled", () => {
    const emitted: Array<[string, unknown]> = [];
    const out = applyBoardReconcile(
      {
        resource: "thread:cmp_acme:proj/alpha",
        state: {
          thread: {
            threadId: "proj/alpha",
            project: "alpha",
            title: "Alpha",
            status: "start",
          },
        },
      },
      [thread()],
      (e, p) => emitted.push([e, p]),
    );
    expect(out.handled).toBe("thread");
    expect(out.threads).toHaveLength(2);
    expect(out.threads[1]).toMatchObject({
      threadId: "proj/alpha",
      companyUid: "cmp_acme",
      status: "start",
    });
    expect(emitted).toEqual([
      [
        "thread:reconciled",
        expect.objectContaining({
          companyUid: "cmp_acme",
          threadId: "proj/alpha",
        }),
      ],
    ]);
  });

  it("work:* applies the reconciled rollup state directly — no refetch seam", () => {
    const emitted: string[] = [];
    const stale = [thread({ status: "blocked" })];
    const out = applyBoardReconcile(
      {
        resource: "work:prs_bob",
        state: {
          threads: [
            {
              threadId: "T-1",
              companyUid: "cmp_acme",
              project: "p",
              title: "t",
              status: "done",
            },
          ],
        },
      },
      stale,
      (e) => emitted.push(e),
    );
    expect(out.handled).toBe("work");
    // The list came from result.state itself (WakeReconciler ordering holds).
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0]).toMatchObject({ threadId: "T-1", status: "done" });
    expect(emitted).toEqual(["work:reconciled"]);
  });

  it("work:* work-item snapshots do not wipe the Board thread list", () => {
    const stale = [thread({ status: "progress" })];
    const out = applyBoardReconcile(
      {
        resource: "work:prs_bob",
        state: { contractVersion: 2, snapshot: true, items: [] },
      },
      stale,
      () => {},
    );
    expect(out.handled).toBe("work");
    expect(out.threads).toBe(stale);
  });

  it("unknown resources are untouched pass-throughs", () => {
    const threads = [thread()];
    const out = applyBoardReconcile(
      { resource: "dm:prs_bob", state: null },
      threads,
      () => {
        throw new Error("must not emit");
      },
    );
    expect(out.handled).toBeNull();
    expect(out.threads).toBe(threads);
  });
});
