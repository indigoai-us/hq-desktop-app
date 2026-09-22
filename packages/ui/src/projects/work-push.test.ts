import { afterEach, describe, expect, it, vi } from "vitest";
import { overlayLiveAssignment } from "./project-view.js";
import type { Story } from "./projects-model.js";
import {
  createProjectRefetchWindow,
  dispatchWorkPush,
  onWorkPush,
  sessionRefFromSessionEvent,
  upsertSessionMarker,
  WORK_PUSH_CHANGED,
  WORK_PUSH_PROJECT_VIEW,
  WORK_PUSH_SESSION,
} from "./work-push.js";

const story: Story = {
  id: "US-006",
  title: "Apply pushes",
  description: "",
  acceptanceCriteria: [],
  passes: false,
  labels: [],
  dependsOn: [],
};

afterEach(() => {
  dispatchWorkPush("nope", {});
});

describe("work pushes (US-006)", () => {
  it("refetches the open project through project-view and coalesces a burst", async () => {
    const timers: Array<() => void> = [];
    const refetch = vi.fn();
    const window = createProjectRefetchWindow({
      isOpen: (id) => id === "proj_open",
      refetch,
      delayMs: 500,
      schedule: (fn) => {
        timers.push(fn);
        return () => {};
      },
    });

    window.note("proj_open");
    window.note("proj_open");
    window.note("proj_open");
    expect(timers).toHaveLength(1);
    expect(refetch).not.toHaveBeenCalled();
    timers[0]();

    const getProjectView = vi.fn(async () => ({
      ok: true,
      value: {
        projectId: "proj_open",
        stories: [
          {
            id: "US-006",
            title: "Apply pushes",
            passes: true,
            assigneeUid: "prs_ada",
            assignee: {
              uid: "prs_ada",
              kind: "person",
              displayName: "Ada",
              avatarRef: null,
            },
          },
        ],
      },
    }));
    const next = await overlayLiveAssignment({
      projectId: "proj_open",
      companyUid: "co_1",
      staticStories: [story],
      getProjectView,
    });
    refetch.mockImplementation(() => {
      void overlayLiveAssignment({
        projectId: "proj_open",
        companyUid: "co_1",
        staticStories: [story],
        getProjectView,
      });
    });
    expect(next[0]?.passes).toBe(true);
    expect(getProjectView).toHaveBeenCalledTimes(1);
    window.dispose();
  });

  it("does not refetch a push for another project", () => {
    const refetch = vi.fn();
    const window = createProjectRefetchWindow({
      isOpen: (id) => id === "proj_open",
      refetch,
      schedule: (fn) => {
        fn();
        return () => {};
      },
    });
    window.note("proj_other");
    expect(refetch).not.toHaveBeenCalled();
    window.dispose();
  });

  it("routes work.changed to the board refresh and a session event onto the card marker", () => {
    const seen: string[] = [];
    const stop = onWorkPush((push) => seen.push(push.kind));
    const refreshBoard = vi.fn();
    const stopBoard = onWorkPush((push) => {
      if (push.kind === "work.changed") refreshBoard();
    });

    dispatchWorkPush(WORK_PUSH_CHANGED, { resourceId: "thr_1" });
    dispatchWorkPush(WORK_PUSH_PROJECT_VIEW, { projectId: "proj_open" });
    dispatchWorkPush(WORK_PUSH_SESSION, {
      event: "awaitingInput",
      projectId: "proj_open",
      storyId: "US-006",
      chatId: "chat_1",
      companyUid: "co_1",
    });

    expect(refreshBoard).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["work.changed", "project-view", "session-event"]);

    const marker = sessionRefFromSessionEvent({
      kind: "session-event",
      event: "awaitingInput",
      projectId: "proj_open",
      storyId: "US-006",
      chatId: "chat_1",
      companyUid: "co_1",
    });
    const sessions = upsertSessionMarker([], marker);
    expect(sessions[0]?.status).toBe("awaiting_input");
    expect(sessions[0]?.project).toBe("US-006");
    const cleared = upsertSessionMarker(
      sessions,
      sessionRefFromSessionEvent({
        kind: "session-event",
        event: "done",
        projectId: "proj_open",
        storyId: "US-006",
        chatId: "chat_1",
        companyUid: "co_1",
      }),
    );
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.status).toBe("done");

    stop();
    stopBoard();
  });
});
