import { describe, expect, it } from "vitest";
import { classifyTasks, groupByTaskColumn, taskPaneStatus, type Story } from "./projects-model.js";
import { mergeStories, parseProjectViewStories } from "./project-view.js";

function story(id: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: [],
    passes: false,
    labels: [],
    dependsOn: [],
    ...extra,
  };
}

// Shepherd 2502 (feedback_a0b4de7f-1da1-4de5-a416-f6d6c7961647): with US-006
// done and the rest queued in the Work Mesh ledger, the first queued story was
// drawn under In progress and Not started was empty.
describe("task columns follow the live ledger status (Shepherd 2502)", () => {
  it("puts a queued first-eligible story under Not started", () => {
    const stories = [
      story("US-006", { passes: true, meshStatus: "done" }),
      story("US-007", { meshStatus: "queued" }),
      story("US-008", { meshStatus: "queued" }),
    ];
    const groups = groupByTaskColumn(classifyTasks(stories, []));
    expect(groups["in-progress"].map((t) => t.story.id)).toEqual([]);
    expect(groups["not-started"].map((t) => t.story.id)).toEqual(["US-007", "US-008"]);
    expect(taskPaneStatus(stories[1], stories, []).label).toBe("To do");
  });

  it("keeps a queued story with notes under Not started", () => {
    const stories = [story("US-001", { meshStatus: "queued", notes: "context" })];
    expect(classifyTasks(stories, [])[0].column).toBe("not-started");
  });

  it("puts in_progress and review stories under In progress even when not first eligible", () => {
    const stories = [
      story("US-001", { meshStatus: "queued" }),
      story("US-002", { meshStatus: "in_progress" }),
      story("US-003", { meshStatus: "review" }),
    ];
    const columns = classifyTasks(stories, []).map((t) => t.column);
    expect(columns).toEqual(["not-started", "in-progress", "in-progress"]);
  });

  it("falls back to the first-eligible rule when there is no live status", () => {
    const stories = [story("US-001"), story("US-002")];
    expect(classifyTasks(stories, []).map((t) => t.column)).toEqual(["in-progress", "not-started"]);
  });

  it("carries the ProjectView status through parse and merge", () => {
    const live = parseProjectViewStories(
      {
        projectId: "launch-backlog",
        stories: [
          { id: "US-006", status: "done", passes: true },
          { id: "US-007", status: "queued", passes: false },
          { id: "US-009", status: "bogus" },
        ],
      },
      "launch-backlog",
    );
    expect(live?.map((s) => s.meshStatus)).toEqual(["done", "queued", null]);
    const merged = mergeStories([story("US-006"), story("US-007")], live);
    expect(merged.find((s) => s.id === "US-007")?.meshStatus).toBe("queued");
    expect(mergeStories([story("US-007")], null)[0].meshStatus).toBeNull();
    expect(classifyTasks(merged, []).find((t) => t.story.id === "US-007")?.column).toBe("not-started");
  });
});
